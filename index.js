/**
 * Created by ed on 3/19/16.
 */
var Promise = require('es6-promise').Promise;

var jsCache = require('js-cache');
var base32 = require('./base32.js');
var EventEmitter = require('events');
var Util = require('util');

var log_err = function() {
    if(global.log)
        log.error.apply(log,arguments);
    else {
        var args = Array.prototype.slice.call(arguments);
        args.unshift("ERROR");
        args.unshift("[SmartCache]");
        console.error.apply(console,args);
    }

};

var log_warn = function() {
    if(global.log)
        log.warn.apply(log,arguments);
    else {
        var args = Array.prototype.slice.call(arguments);
        args.unshift("WARN");
        args.unshift("[SmartCache]");
        console.error.apply(console,args);
    }
};

var ON_log_dbg = function() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift(" {"+(new Date).getTime()+"}");
    args.unshift("[SmartCache]");
    if(global.log)
        log.debug.apply(log,args);
    else
        console.log.apply(console,args);
};


var CacheEmitter = function(cache) {
    this.cache = cache;
    EventEmitter.call(this);
};

Util.inherits(CacheEmitter,EventEmitter);

var SmartCache = function(opts) {
    var smartcache = this;
    var stats = {
        hits: 0,
        misses: 0,
        updateCalls: 0,
        allGets: 0
    };

    var _emitter = new CacheEmitter(this);

    this.events = function() {
        return _emitter;
    }

    var defaultTTL = undefined;
    var defaultThrottle = 2000;
    var updateAfterMisses = false; // this will run the Updater for the key, if the cache misses
                                   // but the Updater is known
    var defaultUpdater = null;     // if set, an Updater which is used for keys not in cache
                                   // and with no known Updater assigned to them

    var log_dbg = function() {};

    if(opts && typeof opts === 'object') {
        if(opts.debug_mode) log_dbg = ON_log_dbg;
        if(typeof opts.defaultTTL === 'number' && opts.defaultTTL > 0) defaultTTL = opts.defaultTTL;
        if(typeof opts.defaultThrottle === 'number' && opts.defaultThrottle > 0) defaultThrottle = opts.defaultThrottle;

        // if updateAfterMisses is set, then the SmartCache will ask the 
        // Updater to try to update keys which might have been in a backing, but had fallen out of 
        // cache, at the next opportunity of the Updater running.
        if(opts.updateAfterMisses) {
            updateAfterMisses = true;
        }
    }

    var cache = new jsCache();

    var backing = null;  // there can be only one Backing per SmartCache

   /**
     * The cacheBackingInterface is passed into the Backing to add keys into the cache.
     * However, any items the Updater manipulates *will use* the given Updater in the future.
     * @param  {[type]} keyForCall The `key` value handed to the updater when this cacheDelegate was also
     * passed in
     * @param  {[type]} updater    The updater using the cacheDelegate
     * @class  cacheDelegate
     */
    var cacheBackingInterface = function(proms){
        var promises = proms;
        var pairs = {};
        this.set = function(key,val){
            if(typeof key === 'string') {
                pairs[key] = val;                
            } else {
                throw new TypeError("Key must be a string");
            }
        }
        this.get = function(key) {
            return cache.get(key);
        }

        this._promises = function() {
            return promises;
        }
        this._pairs = function() {
            return pairs;
        }
    }
    

    /**
     * Provides for a storage backing hooking for the cache.
     * @param {object} callbacks An object with specified callbacks for the Backing interface
     *      {
     *          writeCB: function(pairs) {},
     *          readCB: function(pairs, cache) {},
     *          onConnectCB: function(),
     *          onDisconnectCB: function(),
     *          deserializeCB: function(cache,limit),  // used to load the entire cache for storage
     *          serializeCB: function(cache)     // used to serialize all data in cache.
     *      }
     * `writeCB` A callback which should return a Promise which resolves when the write is complete.
     * The callback is of the form:
     *      function(pairs) {
     *          // pairs is a map of one or more keys like
     *           {  
     *              'somekey' : { val: 'someval', 
     *                            last: '1901232938' // timestamp of data submission
     *           } }
     *          // which should be written to storage
     *      }
     * `readCB` A callback which should return a Promise which resolves when a read is complete.
     *      function(pairs,cache) {
     *          // pairs is an Object of {'key': null} where 'key' should be filled in with the value @ key
     *          // the cache object is provided, the same as handed to the Updater object, to
     *          // all the readCB to provie opportunistic caching if it has new data to hand to the cache
     *          resolve(pairs);
     *      }
     * `onConnectCB` An optional call back which should be called on initialization of the cache.
     * `onDisconnectCB` An optional call back which will be called when the cache goes offline / is `shutdown`
     * @param {object} [opts] If you want the backing to always keep values in cache, use opts.defaultTTL = null;
     */
    this.Backing = function(callbacks,opts) {
        var _selfBacking = this;

        var wrThrottle = null;
        var rdThrottle = null;
        var dlThrottle = null;
        var _id = base32.randomBase32(8);
        var backingTTL = defaultTTL;

        var proper = 0;
        var writeCB,readCB,onConnectCB,onDisconnectCB,serializeCB,deserializeCB;
        if(typeof callbacks === 'object') {
            if(typeof callbacks.writeCB === 'function') {
                writeCB = callbacks.writeCB;
                proper++;
            }
            if(typeof callbacks.readCB === 'function') {
                readCB = callbacks.readCB;
                proper++;
            }
            if(typeof callbacks.deleteCB === 'function') {
                deleteCB = callbacks.deleteCB;
                proper++;
            }            
            if(typeof callbacks.onConnectCB === 'function') {
                onConnectCB = callbacks.onConnectCB;
            }
            if(typeof callbacks.onDisconnectCB === 'function') {
                onDisconnectCB = callbacks.onDisconnectCB;
            }
            if(typeof callbacks.serializeCB === 'function') {
                serializeCB = callbacks.serializeCB;
            }
            if(typeof callbacks.deserializeCB === 'function') {
                deserializeCB = callbacks.deserializeCB;
            }
        }
        if(proper < 3) {
            throw new TypeError("Backing is missing mandatory params or callbacks");
        }

        if(opts && typeof opts === 'object') {
            if(opts.wrThrottle) {
                wrThrottle = opts.wrThrottle;
            }
            if(opts.rdThrottle) {
                rdThrottle = opts.rdThrottle;
            }
            if(opts.id) {
                _id = opts.id;
            }
            if(opts.defaultTTL != undefined) {
                backingTTL = opts.defaultTTL;
            }
        }

        if(!writeCB || typeof writeCB !== 'function'
            || !readCB || typeof readCB !== 'function') {
            throw new TypeError("Missing mandatory parameters");
        }

        this.id = function() {
            return _id;
        }

        writeQ = {};
        writerTimeout = null;
        deleteQ = {};

        this._start = function(cachedelegate) {
            var commit = function(cache_interface) {
                if(cache_interface === null || cache_interface === undefined) {
                    log_dbg("looks like a new backing storage. empty.");
                    return;
                }
                if(!(cache_interface instanceof cacheBackingInterface)) {
                    log_err("Invalid resolve() from Backing onConnectCB() callback. Trouble will insue.");
                    return;
                }
                var pairs = cache_interface._pairs();
                var keyz = Object.keys(pairs);
                for(var n=0;n<keyz.length;n++) {
                    cache.set(keyz[n],pairs[keyz[n]],backingTTL);
                }
                log_dbg("_start(): Backing",_selfBacking.id(),"set",keyz.length,"values");
            }

            if(onConnectCB && typeof onConnectCB === 'function') {
                var ret = onConnectCB(cachedelegate);
                if(ret && typeof ret === 'object' && typeof ret.then === 'function') {
                    return new Promise(function(resolve,reject){
                        ret.then(function(cache_interface){
                            commit(cache_interface);
                            resolve();
                        },function(e){
                            log_err("error in Backing:",e);
                            resolve();
                        }).catch(function(e){
                            log_err("exception in Backing:",e);
                            resolve();
                        })
                    });
                } else {
                    return Promise.resolve();
                }
            } else {
                return Promise.resolve();
            }
        }


        this._write = function(key,val,time) {
            var doWrite = function(){
                var tempQ = writeQ;
                writeQ = {};
                writeCB(tempQ).then(function(){
                    log_dbg("_write() complete");
                },function(e){
                    log_err("error on writing to Backing",_id,e);
                }).catch(function(err){
                    log_err("exception on writing to Backing",_id,err);
                });                
            }

            writeQ[key] = {};
            writeQ[key].val = val;
            if(time !== undefined) {
                writeQ[key].last = time;
            } else {
                writeQ[key].last = Date.now();
            }
            if(wrThrottle) {
                if(writerTimeout) {
                    return;
                } else {
                    writerTimeout = setTimeout(function(){
                        if(writeQ.length > 0)
                            doWrite();
                        writerTimeout = null;
                    },wrThrottle);
                    doWrite();
                }
            } else {
                doWrite();
            }
        };

        this._delete = function(key) {
            var doDelete = function(){
                var tempQ = deleteQ;
                deleteQ = [];
                var tempKeys = Object.keys(tempQ);
                return deleteCB(tempKeys).then(function(){
                    log_dbg("_delete() complete");
                    var _n = tempKeys.length;
                    while(_n--) {
                        if(typeof tempQ[tempKeys[_n]] == 'object' && tempQ[tempKeys[_n]].resolve) {
                            tempQ[tempKeys[_n]].resolve();
                        }
                    }
                },function(e){
                    log_err("error on writing to Backing",_id,e);
                }).catch(function(err){
                    log_err("exception on writing to Backing",_id,err);
                });                
            }

            var makeDelQEntry = function(key) {
                deleteQ[key] = {};
                deleteQ[key].promise = new Promise(function(resolve,reject){
                    deleteQ[key].resolve = resolve;
                    deleteQ[key].reject = reject;
                });
                return deleteQ[key].promise;
            }
//            deleteQ[key] = 1;
            var p = makeDelQEntry(key);

            if(dlThrottle) {
                if(deleteTimeout) {
                    return;
                } else {
                    deleteTimeout = setTimeout(function(){
                        if(deleteQ.length > 0)
                            doDelete();
                        deleteTimeout = null;
                    },dlThrottle);
                    doDelete();
                }
            } else {
                doDelete();
            }

            return p;
        };

        var readQ = {};
        var readerTimeout = null;
        var promisesTokensByKey = {};

        this._read = function(key) {
            var doRead = function(Q) {
                var tempQ = readQ;
                readQ = {};
//console.trace("doRead 1")
                var cache_interface = new cacheBackingInterface(promisesTokensByKey);
                promisesTokensByKey = {};
//log_dbg("doRead 1.1")                
                readCB(Object.keys(tempQ),cache_interface).then(function(cache_interface){
                    if(!(cache_interface instanceof cacheBackingInterface)) {
                        log_err("Invalid resolve() from Backing read callback. Trouble will insue.");
                        return;
                    }
//log_dbg("doRead 2")
                    // if(!outQ || typeof outQ !== 'object') {
                        
//log_dbg("doRead 3")

                    var proms = cache_interface._promises(); // the promisesTokensByKey
                    var pairs = cache_interface._pairs();
                    var keyz = Object.keys(pairs);
                    for(var n=0;n<keyz.length;n++) {
//log_dbg("doRead 4")
                        cache.set(keyz[n],pairs[keyz[n]],backingTTL);
                        if(proms[keyz[n]]) { // fulfill any promises
                            if(typeof proms[keyz[n]].resolve == 'function') {
                                proms[keyz[n]].resolve(pairs[keyz[n]]);     
                            }                           
                            delete proms[keyz[n]];
                        }
                    }
                    log_dbg("Backing",_selfBacking.id(),"set",keyz.length,"values");
                    keyz = Object.keys(proms);
                    for(var n=0;n<keyz.length;n++) {
                        if(typeof proms[keyz[n]].reject == 'function') {
                            proms[keyz[n]].reject();                            
                        }
                    }
                    log_dbg("Backing",_selfBacking.id(),"had",keyz.length,"reject()s");
                    // }
                });
            };
//log_dbg("_read 0")
            if(promisesTokensByKey[key] && typeof promisesTokensByKey[key] === 'object') {
                return promisesTokensByKey[key].promise;
            } else {
                promisesTokensByKey[key] = {}  
//log_dbg("_read 1")
                var ret_prom = promisesTokensByKey[key].promise = new Promise(function(resolve,reject) {
                    promisesTokensByKey[key].resolve = resolve;
                    promisesTokensByKey[key].reject = reject;
                });
                readQ[key] = 1;
            }

            if(!readerTimeout) {
                log_dbg("_read 2")
                if(rdThrottle) {
                    readerTimeout = setTimeout(function(){
                        var keyz = Object.keys(readQ);
                        if(keyz.length > 0)
                            doRead();
                        readerTimeout = null;
                    },rdThrottle);
//log_dbg("_read 2.2")
                    doRead();
                } else {
//log_dbg("_read 2.2")
                    doRead();
                }
            }
            return ret_prom;
        }

    };



    this.setBacking = function(_backing) {
        return new Promise(function(resolve,reject){
            if(_backing instanceof smartcache.Backing) {
                var cache_interface = new cacheBackingInterface({});
                _backing._start(cache_interface).then(function(){
                    backing = _backing;
                    resolve();
                },function(e){
                    log_err("Error starting Backing",_backing.id());
                    reject();
                }).catch(function(e){
                    log_err("@catch - exception on backing start():",e);
                })
            } else {
                reject();
                throw new TypeError("Backing must be instance of [smartcache instance].Backing");
            }
        });
    }


    /**
     * The cacheDelegate is passed into the Updater, so the updater can
     * add/remove items to the cache during it's run (opportunistic caching)
     * However, any items the Updater manipulates *will use* the given Updater in the future.
     * @param  {[type]} keyForCall The `key` value handed to the updater when this cacheDelegate was also
     * passed in
     * @param  {[type]} updater    The updater using the cacheDelegate
     * @class  cacheDelegate
     */
    var cacheDelegate = function(updater){
        this._dirty = false;
        this._updater = updater;
        this._writeQ = {}; this._readQ = {}; this._delQ = {}; this._runToken = null;
    }


    cacheDelegate.prototype.isDirty = function() {
        return this._dirty;
    }

    cacheDelegate.prototype.getUpdateToken = function() {
        // if dlTokenQ[key] ?? 
        // if wrTokenQ[key] ??
        this._dirty = true;
        if(this._runToken) {
            return this._runToken;
        }
        this._runToken = {}
        var self = this;
        this._runToken.promise = new Promise(function(resolve,reject){
            self._runToken.resolve = resolve;
            self._runToken.reject = reject;
        });
        return this._runToken;
    }    
    cacheDelegate.prototype.addWriteToken = function(key) {
        // if dlTokenQ[key] ?? 
        // if wrTokenQ[key] ??
        this._dirty = true;
        if(this._writeQ[key]) {
            return this._writeQ[key];
        }
        var token = {
            key: key
         }
        token.promise = new Promise(function(resolve,reject){
            token.resolve = resolve;
            token.reject = reject;
        });
        this._writeQ[key] = token;
//        console.trace("ARI ********* _writeQ",key,this._writeQ);
        return token;
    }
    cacheDelegate.prototype.addReadTokenNoPromise = function(key) {
        this._dirty = true;
//        log_dbg("ARI ********* _readQ",key,this._readQ);
        if(this._readQ[key]) {
            return this._readQ[key];
        }
        var token = {
            key: key
        };
        this._readQ[key] = token;
        return token;
    }

    cacheDelegate.prototype.addReadToken = function(key) {
        this._dirty = true;
        if(this._readQ[key]) {
            return this._readQ[key];
        }
        var token = {
            key: key
        };
        token.promise = new Promise(function(resolve,reject){
            token.resolve = resolve;
            token.reject = reject;
        });
        this._readQ[key] = token;
        return token;
    }
    cacheDelegate.prototype.addDelToken = function(key) {
        this._dirty = true;
        if(this._delQ[key]) {
            return this._delQ[key];
        }
        var token = {
            key: key
        };
        token.promise = new Promise(function(resolve,reject){
            token.resolve = resolve;
            token.reject = reject;
        });
        this._delQ[key] = token;
        return token;

    }
    cacheDelegate.prototype.sanitizeForUser = function() {
        // this prepares the delegate to go to calling code.\
        // by shadowing out the functions
        this.addDelToken = null;
        this.addReadToken = null;
        this.addWriteToken = null;
    }

    cacheDelegate.prototype.getReadReqs = function() {
//        log_dbg('ARI getReadReqs:',Object.keys(this._readQ));
        return Object.keys(this._readQ);
    }
    cacheDelegate.prototype.getWriteReqs = function() {
        return Object.keys(this._writeQ);
    }
    cacheDelegate.prototype.getDelReqs = function() {
        return Object.keys(this._delQ);
    }



    // These three function to be used by the Updater implementer:
    cacheDelegate.prototype.set = function(key,val,ttl){
        log_dbg("cacheDelegate:",key,val,ttl);
        log_dbg("updater:",this._updater)
        _setData(key,val,ttl,this._updater);
//        console.trace('past set',this._readQ);
        if(this._readQ[key]) { // readQ - if the data is 'set' by the Updater
                               // then it has accomplished the 'read'
            // it's possible it might be an opportunistic read (see 'updateAfterMisses'
            // options) in which case there would be no promise resolve() func
            if(typeof this._readQ[key].resolve == 'function') {
                this._readQ[key].resolve();
            } else {
                // if the data is set - but it does not have a resolve()
                // function, then just delete it
                delete this._readQ[key];
            }
        }
    }
    cacheDelegate.prototype.get = function(key) {
        return cache.get(key);
    }
    cacheDelegate.prototype.del = function(key) {
        var uid = this._updater.id();
        console.log("uid = ",uid);
        deleteTableByKey[key] = 1; // mark to ingore when we get 'del' event
        _deleteKey(key,'updater',uid);
//        smartcache.removeData(key);
        if(this._delQ[key]) { // readQ - if the data is 'set' by the Updater
                              // then it has accomplished the 'read'
            this._delQ[key].resolve();
//            delete this._delQ[key];
        }


    }
    //     writeQueue,  // the queue used to tell the Updater to set a value at the Updater's end
    //     readQueue,   // the queue for telling the Updater to read a value at the Updater's end
    //                  // i.e read value, and then Updater places it into cache
    //     delQueue     // the queue used to ask the Updater to delete a value 
    //                  // from the Updater's end
    cacheDelegate.prototype.setComplete = function(key) {
        if(this._writeQ[key]) {
            this._writeQ[key].resolve();
            delete this._writeQ[key];
            return;            
        }
        if(this._readQ[key]) {
            if(typeof this._readQ[key].resolve == 'function') {
                this._readQ[key].resolve();                
            }
            delete this._readQ[key];
            return;            
        }
        if(this._delQ[key]) {
            this._delQ[key].resolve();
            delete this._delQ[key];
            return;
        }
        throw new ReferenceError("key "+key+" is not in delegate cache.");
    }
    cacheDelegate.prototype.setFail = function(key,e) {
        if(this._writeQ[key]) {
            this._writeQ[key].reject(e);
            delete this._writeQ[key];
            return;            
        }
        if(this._readQ[key]) {
            if(typeof this._readQ[key].reject == 'function') {
                this._readQ[key].reject(e);
            }
            delete this._readQ[key];
            return;            
        }
        if(this._delQ[key]) {
            this._delQ[key].reject(e);
            delete this._delQ[key];
            return;            
        }
        throw new ReferenceError("key "+key+" is not in delegate cache.");
    }
    // should be called after updater completes
    // this looks for non-complete requests & fails them
    cacheDelegate.prototype._complete = function(err) {
        var Qs = {w:this._writeQ,r:this._readQ,d:this._delQ};
        for(var Q in Qs) {
            var keyz = Object.keys(Qs[Q]);
            for(var n=0;n<keyz.length;n++) {
                if(typeof Qs[Q][keyz[n]].reject == 'function') {
                    Qs[Q][keyz[n]].reject();                    
                }
                delete Qs[Q][keyz[n]];
            }            
        }
        if(this._runToken) {
            log_dbg("runToken",this._runToken);
            if(err) {
                this._runToken.reject(err);                
            } else {
                this._runToken.resolve();                
            }
        }        
    }



    /**
     * An updater takes a callback. That callback does two things:
     *      function callback(cache) {
     *          var setkeys = cache.getWriteReqs(); // The `setkeys` is an array of keys which need to be set by the Updater      
     *          var getkeys = cache.getReadReqs();  // need to get read by the Updater - and then, set() in the cache
     *          var delkeys = cache.getDelReqs();
     *          console.log("I am Updater:",this.id()); // this refers to the Updater
     *          for(var n=0;n<setkeys.length;n++) {
     *              console.log("Updating key",setkeys[n]);
     *              externalSetFunc(setkeys[n],cache.get(setkeys[n])); // or any other arbritrary magic!
     *              cache.setComplete(keys[n]);  // let the cache know this work was completed
     *          }
     *          for(var n=0;n<delkeys.length;n++) {
     *              console.log("Deleting key",delkeys[n]);
     *              externalDelFunc(delkeys[n]); // or any other arbritrary magic!
     *              cache.setComplete(delkeys[n]);
     *              
     *          }
     *          for(var n=0;n<getkeys.length;n++) {
     *              console.log("Updating key",getkeys[n]);
     *              if(keys[n] == "something not here") {
     *                  cache.setFail(keys[n]); // you can mark certain keys as failing. So this 'set' failed.
     *                                          // this is 'fail fast' - note, any key request not marked 
     *                                          // with `setComplete(key)` is automatically considered failing
     *                                          // at the end of the call
     *              } else {
     *                  cache.set(getkeys[n],externalGetFunc(getkeys[n])); // or any other arbritrary magic!
     *                  //cache.setComplete(getkeys[n]); // can be done, automatically marked as complete when cache.set is called
     *              }
     *          }
     *          cache.set('newkey',someval);  // the updater may also set new keys during the update
     *                                        // (opportunistic caching)
     *          return Promise.resolve(); // should always return a Promise - and should resolve() unless
     *                                    // critical error happened.
     *      }
     * 
     * @param {Function} callback
     * @param {Function} [onDeleteCallback] An optional callback of the form:
     *      function callback(val,key,cache) {}
     * This callback is called when the updater's key is deleted in cache. The `val` is the
     * last `val` in the cache before deletion. The `onDeleteCallback` is optional.
     * @param {Function} [onShutdownCB] This is an optional function which is called when the
     * Updater is no longer needed by any key
     * @param {Object} [opts] Options. If provided, this must be the fourth argument:
     *      {
     *         interval: 60*1000, // an optional refresh interval the Updater should be called
     *                            // if this is called, an no data changes have occurred from the SmartCache
     *                            // perspective, then `setkeys` and `getkeys` are just empty
     *         throttle: 5000,    // only call the updater every 5 seconds, no quicker
     *         id: "someName"     // a specified ID name, otherwise a random new name will be generated
     *                            // useful if replacing an Updater
     *         equalityCB: function(key,newval,oldval) { // a compartor function
     *              return (newval==oldval);         // the default is `==` - but this 
     *                                               // allows implementer to do object comparison
     *         }
     *      } The interval the updater should self update if desired.
     * @return {any} Any value, but always return the updated data - even if no change. A return
     * of `undefined` will effectively remove the data from the cache.
     * @constructor
     */
    this.Updater = function(callback,onShutdownCB,opts) {
        var _selfUpdater = this;
        if(typeof callback != 'function') {
            throw new TypeError("Updater only takes [Function]");
        }
        var _cb = callback;
        var _id = base32.randomBase32(8);
        var _shutdownCB = onShutdownCB;

        var _throttleTimer = null;
        var _intervalTimer = null;
        var shutdown = false;
        // var _throttleCbQ = [];

        this.shutdown = function() {
            shutdown = true;
            if(_throttleTimer) {
                clearTimeout(_throttleTimer);
            }
            if(_intervalTimer) {
                clearTimeout(_intervalTimer);
            }
            if(_shutdownCB && typeof _shutdownCB === 'function') {
                _shutdownCB();
            }
        }

        this._ref = 0;

        this.getOpts = function() {
            return options;
        }

        var options = opts;
        var throttle = defaultThrottle;
        if(options) {
            if(typeof options !== 'object') {
                throw new TypeError("Bad parameter.");
            }
            if(options.id) {
                _id = options.id;
                delete options.id;
            }
            if(options.throttle) {
                throttle = options.throttle;
            }
            if(options.interval && typeof options.interval != 'number') {
                throw new TypeError("options.interval must be a number");
            }
            if(options.interval && options.throttle && options.interval < options.throttle) {
                throw new RangeError("options.interval must be > options.throttle");
            }
            if(options.equalityCB && typeof options.equalityCB != 'function') {
                throw new TypeError("options.equalityCB must be a [function]");
            }
        } else {
            options = {};
        }

        this.id = function() {
            return _id;
        }



        var currentDelgCache = new cacheDelegate(_selfUpdater);

        // these return promises
        this.getData = function(key) {
            var ret = currentDelgCache.addReadToken(key);
            selfUpdate();
            return ret.promise;
        }
        this.setData = function(key) {
            var ret = currentDelgCache.addWriteToken(key);
            selfUpdate();
            return ret.promise;
        }
        this.removeData = function(key) {
            var ret = currentDelgCache.addDelToken(key);
            selfUpdate();
            return ret.promise;
        }
        this.askForOpportunisticRead = function(key) {
//            log_dbg("ARI askForOpportunisticRead:",key);
            currentDelgCache.addReadTokenNoPromise(key);  
            selfUpdate();                      
        }

        // just ask for an update
        this.update = function(){
            var ret = currentDelgCache.getUpdateToken();
            selfUpdate();
            return ret.promise;
        }

        /** called when an interval expires, or when a value
         * falls out of the cache
         * @param data
         * @returns {*}
         */
        var selfUpdate = function() {

            var doUpdate = function(){
                if(shutdown) {
                    return;
                }
                if(!currentDelgCache.isDirty() && !options.interval) {
                    log_dbg("skipping update, cache not dirty.");
                    return;
                }
//                var tempQ = updateTokenQ;
//                updateTokenQ = {};
                var delg = currentDelgCache;
                currentDelgCache = new cacheDelegate(_selfUpdater);
                _throttleTimer = 1; // this prevents updates from getting run on top of each other
                stats.updateCalls++;
                var ret = null;
                try {
                    ret = _cb.call(_selfUpdater,delg);
                } catch(e) {
                    log_err("@catch in updater",_selfUpdater.id(),"callback:",e);
                    delg._complete(e);
                    _throttleTimer = setTimeout(function(){
                        log_dbg("THROTTLE: "+_id+" in timeout for throttle");
                        doUpdate();
                    },throttle);
                }
                if(ret && typeof ret === 'object' && typeof ret.then === 'function') {
                    ret.then(function(r){
                        delg._complete();
                        if(shutdown) {
                            return;
                        }
                        if(currentDelgCache.isDirty()) {
                            _throttleTimer = setTimeout(function(){
                                log_dbg("THROTTLE: "+_id+" in timeout for throttle");
                                doUpdate();
                            },throttle);
                            log_dbg("THROTTLE: "+_id+" Throttle set, next call in",throttle,"ms");
                        } else {
                            if(options.interval) {
                                _intervalTimer = setTimeout(function(){
                                    log_dbg("INTERVAL: "+_id+" in timeout for interval");
                                    _intervalTimer = null;
                                    doUpdate();
                                },options.interval);
                                log_dbg("INTERVAL: "+_id+" Timer set, next call in",options.interval,"ms");
                            }
                            _throttleTimer = null;
                        }
                        // completeWaits_resolve(_throttleCbQ,r);
                        // _throttleCbQ = [];
                        // _throttleTimer = null;
                    },function(err){
                        log_err("@reject in throttled selfUpdate.doUpdate()",err);
                        delg._complete(err);
                        if(currentDelgCache.isDirty()) {
                            _throttleTimer = setTimeout(function(){
                                doUpdate();
                            },throttle);
                        } else {
                            if(options.interval) {
                                _intervalTimer = setTimeout(function(){
                                    log_dbg("INTERVAL: "+_id+" in timeout for interval");
                                    _intervalTimer = null;
                                    doUpdate();
                                },options.interval);
                                log_dbg("INTERVAL: "+_id+" Timer set, next call in",options.interval,"ms");
                            }
                            _throttleTimer = null;
                        }

                        // completeWaits_reject(_throttleCbQ,err);
                        // _throttleCbQ = [];
                        // _throttleTimer = null;
                    }).catch(function(e){
                        log_err("@.catch() in throttled selfUpdate.doUpdate()",e);
                        delg._complete(e);
                        if(currentDelgCache.isDirty()) {
                            _throttleTimer = setTimeout(function(){
                                doUpdate();
                            },throttle);
                        } else {
                            if(options.interval) {
                                _intervalTimer = setTimeout(function(){
                                    log_dbg("INTERVAL: "+_id+" in timeout for interval");
                                    _intervalTimer = null;
                                    doUpdate();
                                },options.interval);
                                log_dbg("INTERVAL: "+_id+" Timer set, next call in",options.interval,"ms");
                            }                            
                            _throttleTimer = null;
                        }


                        // completeWaits_reject(_throttleCbQ,e);
                        // _throttleCbQ = [];
                        // _throttleTimer = null;
                    });
                } else {
                    log_err("Updater",_selfUpdater.id(),"callback must return a promise.");
                    var delg = new cacheDelegate(_selfUpdater);
                }
            }

            if(_throttleTimer !== null) { // Already in montion: a callback is running or just ran, 
                                 // still in throttle window
                return;
            } else {
                if(_intervalTimer) {
                    // if we are also waiting on an interval, clear it
                    // (it will get reset after this call completes)
                    log_dbg("Canceling INTERVAL");
                    clearTimeout(_intervalTimer);
                }
                doUpdate();
            }
        }

    }



    var updaterTableByKey = {}; // by key name : Updater.id
    var timerTable = {};   // by Updater.id

    var updatersById = {}; // all updaters, by ID

    var deleteTableByKey = {}; // this table marks a key, if it's explicity deleted.
                               // we use this track to if a key is deleted vs. just 
                               // falling out of the cache

    var _removeUpdater = function(u_id) {
        if(u_id) {
            var u = updatersById[u_id];
            if(u) {
                u._ref--; if(u._ref < 0) u._ref = 0;
                log_dbg("Decreasing Updater:",u_id,"ref count to",u._ref);
                if(u._ref < 1 && (u_id != defaultUpdater)) {
                    log_dbg("Removing Updater:",u_id);
                    var tid = timerTable[u_id];
                    if(tid !== undefined) {
                        clearTimeout(tid);
                        delete timerTable[u_id];
                    }
                    updatersById[u_id].shutdown();
                    delete updatersById[u_id];
                }
            }
        }
    }

    var getUpdaterByKey = function(key) {
        var u_id = updaterTableByKey[key];
        if(u_id) {
            var u = updatersById[u_id];
            return u;
        }
        return null;
    }

    var _addUpdater = function(key,updater) {
        if(updater && updater instanceof smartcache.Updater) {
            var uid = updater.id();
            if(key) {
                var old_updater_uid = updaterTableByKey[key];
                if(old_updater_uid) {
                    _removeUpdater(old_updater_uid);
                }
                updaterTableByKey[key] = uid;
                updater._ref++;
                updatersById[uid] = updater;                
                log_dbg("Adding updater:",uid,"(ref =",updater._ref+")",updaterTableByKey);
            } else {
                if(!updatersById[uid]) {
                    updatersById[uid] = updater;
                }
            }
        } else {
            throw new TypeError("Bad parameter - needs [string],[Updater:Object]");
        }
    }

    var getUpdaterByUpdaterId = function(id) {
        return updatersById[id];
    }

    /**
     * Internal _setData is used by the cacheDelegate
     * @private
     * @param {[type]} key     [description]
     * @param {[type]} val     [description]
     * @param {[type]} ttl     [description]
     * @param {[type]} updater [description]
     */
    var _setData = function(key,val,ttl,updater) {
//        log_dbg("ARI _setData ",arguments);
        var sendEvent = function(existing,source,id) {
            var change = false;
            log_dbg("sendEvent",arguments);
            if(existing) {
                if(updater && updater.getOpts().equalityCB) {
                    change = !updater.getOpts().equalityCB(key,val,existing);
                } else {
                    if(typeof existing !== 'object')
                        change = !(existing == val);
                    else
                        change = true;
                }
                if(change) { _emitter.emit('change',key,val,source,id); }
            } else {
                _emitter.emit('new',key,val,source,id)
            }
        }

        if(ttl == undefined && defaultTTL) {
            ttl = defaultTTL;
        }
        var existing = cache.get(key);
        log_dbg("key:",key,"existing:",existing,"newval:",val);
        var t = Date.now();
        cache.set(key,val,ttl);
        sendEvent(existing,'updater',updater.id());
        updaterTableByKey[key] = updater.id();
        if(backing) {
            backing._write(key,val,t);
        }
    }

    // internal delete. This should happen
    // on any delete key
    // @param {String} source who asked for delete: 'updater' or 'user'
    var _deleteKey = function(key,source,updaterid) {
log_dbg("removeData #2")
        var u_id = updaterTableByKey[key];
        var u = getUpdaterByKey(key);
        if(u && ((source != 'updater') || 
            (updaterid != u_id))) {
log_dbg("removeData #3")
            // the 'key' has an updater AND
            // if its NOT an updater calling, or its an Updater updating something
            // for which its not the Updater (whew)
            deleteTableByKey[key] = 1; // mark to ingore when we get 'del' event
            return u.removeData(key).then(function(){ // NOTE: it is the Updater's responsibility
                                                      // to actually remove it from cache

            }); 
        } else {
log_dbg("removeData #4")
            if(u_id) {
                delete updaterTableByKey[key];
                _removeUpdater(u_id);             
            }
log_dbg("removeData #5")            
            cache.del(key);
            _emitter.emit('del',key,source,u_id);
            if(backing) {
log_dbg("removeData #6")                
                return backing._delete(key);
            } else {
log_dbg("removeData #7")                
                return Promise.resolve();
            }            
        }

    }

    /**
     * Drops the key out of cache (although its storage will remain)
     * and asks its Updater to refresh it's value
     * @param  {[type]} key [description]
     * @return {[type]}     [description]
     */
    this.invalidateKey = function(key) {
        // drop the key out of cache. If it has an updater
        // it's updater should run the next time it's needed.
        cache.del(key);
        var u = getUpdaterByKey(key);
        if(u) {
            u.getData(key); // schedule an updater ask for the data.
        }
    }



    /**
     * Sets data in cache.
     * A word on Updaters. If the Updater is set, it will used to update the data after the
     * data is set in the cache.
     * @param key
     * @param val
     * @param  {Object} [opts] Options are:
     *     {
     *        ttl: 1000, // the TTL timeout in milliseconds. If not
     *                   // set the cache will never go old
     *        updater: myUpdater,  // an instance of an Updater
     *        noBacking: true      // if true the backing will not be written to (default: false)
     *     }
     * @param updater
     * @return {Promise} A Promise which fulfills when the Updater sets the data, or otherwise fulfills
     * immediately.
     */
    this.setData = function(key,val,opts) {

         var sendEvent = function(existing,source,updater) {
            var change = false;
            log_dbg("sendEvent",arguments);
            if(existing) {
                if(updater && updater.getOpts().equalityCB) {
                    change = updater.getOpts().equalityCB(key,val,existing);
                } else {
                    if(typeof existing !== 'object')
                        change = !(existing == val);
                    else
                        change = true;
                }
                if(change) { _emitter.emit('change',key,val,source); }
            } else {
                _emitter.emit('new',key,val,source)
            }
        }

        var updater = undefined;
        var ttl = undefined;
        var noBacking = undefined;
        if(typeof opts === 'object') {
            if(opts.updater !== undefined) {
                if(opts.updater instanceof smartcache.Updater) updater = opts.updater;
                else if(typeof opts.updater === 'string') {
                    updater = getUpdaterByUpdaterId(opts.updater);
                    if(!updater) {
                        throw new TypeError("Bad paran. updater must be valid updater ID or Updater object.");
                    }
                } else
                    throw new TypeError("Bad option. option.updater must be an Updater");
            }
            if(typeof opts.ttl === 'number' && opts.ttl > 0)
                ttl = opts.ttl;
            noBacking = opts.noBacking;
        } else if(defaultTTL) {
            ttl = defaultTTL;
        }
        var u_id = null;
        var existing = cache.get(key);
        if(updater) { // !existing && 
            _addUpdater(key,updater);
        }
        if(!updater) {
            updater = getUpdaterByKey(key);
        }
        // update value in cache
        var t = Date.now();
        cache.set(key,val,ttl);
        sendEvent(existing,'caller',updater);
        if(updater) {
            return updater.setData(key).then(function(){
                if(backing && !noBacking) {
                    backing._write(key,val,t);
                }
            },function(){
                log_dbg("Note: updater failed key:",key);
                cache.set(key,existing,ttl);
            });
        } else {
            if(!noBacking) {
                backing._write(key,val,t);
            }
            return Promise.resolve();
        }
    };

    this.runUpdaters = function(specified) {
        if(specified) {
            if(updatersById[specified]) {
                var ret = null;
                ret = updatersById[specified].update();
                return ret;
            } else {
                log_err("No updater with given ID",specified);
                return Promise.reject("No updater with given ID");
            }
        }
        var ids = Object.keys(updatersById);
        var proms = [];
        for(var n=0;n<ids.length;n++) {
            log_dbg("runUpdaters:",ids[n]);
            var ret = null;
            ret = updatersById[ids[n]].update();
            if(ret) proms.push(ret);
        }
        if(proms.length > 0)
            return Promise.all(proms);
        else
            return Promise.reject("no updaters or all failed.");
    };

    /**
     * Installs an Updater to the cache. This will cause the Updater's update
     * function to run based on its interval settings.
     * @param {[type]} updater [description]
     */
    this.addUpdater = function(updater) {
        _addUpdater(null,updater);
    };

    /**
     * Set the default Updater. The Updater must already be installed.
     * This updater will be called when a key is not in cache, _and_ has no
     * specified Updater.
     * @param {[type]} updater_id [description]
     */
    this.setDefaultUpdater = function(updater_id) {
        if(typeof updater_id == 'string') {
            var updater = updatersById[updater_id];
            if(updater) {
                defaultUpdater = updater_id;               
            } else {
                throw new Error("Updater id "+updater_id+" is not known.");
            }
        } else {
            throw new TypeError('bad parameter');
        }

    }

    /**
     * Gets data from the cache.
     * @param {String} key A string of the key caller wants
     * @param {object} [opts] Options are:
     *     {
     *         prefer: 'storage'  // | 'updater' - If prefer 'storage' and the key is not in cache
     *                            // then the backing store will be used if available and it has the key
     *                            // otherwise an updater will be tried (default, if backing is present)
     *                            // If prefer 'updater' then the backing store will be ignored
     *     }
     * @return {Promise} which resolves if the data is retrieved. If the data can not be
     * retrieved then the Promise rejects. If the data is just `undefined`, the Promise resolves with `undefined`.
     */
    this.getData = function(key,opts) {
        stats.allGets++;
        var d = cache.get(key);
        if(d !== undefined) {
            stats.hits++;
            // if its in cache, fast-track it
            return Promise.resolve(d);
        }
        var prefer = 'either';
        if(opts && opts.prefer) {
            prefer = opts.prefer;
        }
        return new Promise(function(resolve,reject) {
            // why twice? (also above)
            // b/c there is a slight chance that data could have made it into  
            // cache b/t these execution moments.
            var d = cache.get(key);
            if(d !== undefined) {
                stats.hits++;
                resolve(d);
                return;
            }
            if(prefer == 'updater' || !backing) {
                log_dbg("   -> prefer says ignore backing storage");
                var u = getUpdaterByKey(key);
                if(u) {
                    log_dbg("Key",key,"not in cache but have updater. Updating.");
                    u.getData(key).then(function(){
                        stats.misses++;
                        resolve(cache.get(key));
                    },function(err){
                        if(backing) {
                            log_err("Error back from Updater - will try backing:",err);                            
                            backing._read(key).then(function(r){
                                log_dbg("got read resolve");
                                stats.misses++;
                                resolve(r);
                            },function(e){
                                log_dbg("   -> reject from storage.",e);                                
                                resolve(undefined);
                            }).catch(function(e){
                                log_dbg("   -> @catch from storage.",e);                                
                                reject(e);                                
                            });
                        } else {
                            log_err("Error back from Updater - no backing.",err);
                            reject(err);
                        }
                    }).catch(function(e){
                        if(backing) {
                            log_err("@catch Updater - will try backing:",err);                            
                            backing._read(key).then(function(r){
                                log_dbg("got read resolve");
                                stats.misses++;
                                resolve(r);
                            },function(e){
                                log_dbg("   -> reject from storage.",e);                                
                                reject(e);
                            }).catch(function(e){
                                log_dbg("   -> @catch from storage.",e);                                
                                reject(e);                                
                            });
                        } else {
                            log_err("@catch ",e);
                            reject(e);
                        }
                    });
                } else {
                    // FIXME - ARE MISSES resolve() or not??
                    // use the defaultUpdater here
                    if(defaultUpdater) {
                        var u = updatersById[defaultUpdater];
                        if(u) {
                            log_dbg("attempt defaultUpdater",defaultUpdater,"for key:",key);
                            u.getData(key).then(function(){
                                stats.misses++;
                                resolve(cache.get(key));
                            },function(e){
                                log_dbg("no result. failure @error",e);
                                resolve(undefined);
                            }).catch(function(e){
                                log_err("failure @catch",e);
                                reject(e);
                            });
                        } else {
                            log_err("default Updater is missing!! ",defaultUpdater,"null-ing out");
                            defaultUpdater = null
                            resolve();
                        }
                    } else {
                        log_dbg("   no Updater, no Data! [",key,"]");
                        // no updater, no data, just nothing:
                        resolve();
                    }
                }
            } else {
                log_dbg("trying backing for:",key);
                backing._read(key).then(function(r){
                    log_dbg("got read resolve (via backing)");
                    stats.misses++;
                    resolve(r);

                    if(updateAfterMisses) {
                        log_dbg("   -> resolved with backing, but asking for opportunistic read. [",key,"]");
                        var u = getUpdaterByKey(key);
                        if(u) {
                            u.askForOpportunisticRead(key);
                        } else {
                            log_dbg("      oop. no updater for key",key);
                        }
                    }
                    // TODO: run updater anyway?
                    // we had to use the backing to get the value, but since it was asked for
                    // should it be updater?
                },function(err){
                    log_dbg("   -> reject from storage. trying updater.");
                    var u = getUpdaterByKey(key);
                    if(u) {
                        log_dbg("Key",key,"not in cache but have updater. Updating.");
                        u.getData(key).then(function(){
                            log_dbg("Updater resolve()d");
                            resolve(cache.get(key));
                            stats.misses++;
                        },function(err){
                            log_err("Error back from Updater.",err);
                            resolve(undefined);
                        }).catch(function(e){
                            log_err("@catch ",e);
                            reject(e);
                        });
                    } else {
                        log_dbg("No updater. No data.");

                        if(defaultUpdater) {
                            var u = updatersById[defaultUpdater];
                            if(u) {
                                log_dbg("attempt defaultUpdater",defaultUpdater,"for key:",key);
                                u.getData(key).then(function(){
                                    stats.misses++;
                                    resolve(cache.get(key));
                                },function(e){
                                    log_dbg("no result. failure @error",e);
                                    resolve(undefined);
                                }).catch(function(e){
                                    log_err("failure @catch",e);
                                    reject(e);
                                });
                            } else {
                                log_err("default Updater is missing!! ",defaultUpdater,"null-ing out");
                                defaultUpdater = null
                                resolve();
                            }
                        } else {
                            log_dbg("   no Updater, no Data! [",key,"]");
                            // no updater, no data, just nothing:
                            resolve();                        
                        }
                        // no updater, no data, just nothing. ok.
                        // resolve to undefined
//                        resolve();
                    }
                }).catch(function(e){
                    log_err("@catch - error",e);
                    reject();
                });
            }
        });
    }

    this.removeData = function(key) {
        var uid = undefined;
        var u = getUpdaterByKey(key);
        if(u) uid = u.id();
        return _deleteKey(key,'user',uid);
    }

    // handle events - if an entry is kicked out of cached, its updater
    // needs to run
    
    cache.on('del',function(key){
        if(!deleteTableByKey[key]) {
            log_dbg("Key falling out of cache:",key,updaterTableByKey);
            //if(autorefresh) {}
            return;
        }
        log_dbg("Saw cache (real)delete of key:",key);
        if(deleteTableByKey[key]) {
            var u_id = updaterTableByKey[key];
            if(u_id) {
                var u = updatersById[u_id];
                var ret = u.removeData(key);
            }
            delete deleteTableByKey[key];
        } else {
            // just remove from delete table - do nothing else.
            delete deleteTableByKey[key];
        }
    });


    this.clear = function() {
        // release all timers. clear all cache.
        cache.clear();
        var timers = Object.keys(timerTable);
        for(var n=0;n<timers.length;n++) {
            clearTimeout(timerTable[timers[n]]);
            delete timerTable[timers[n]];
        }
        var updaters = Object.keys(updatersById);
        for(var n=0;n<updaters.length;n++) {
            if(updaters[n] != defaultUpdater) {
                log_dbg("updater " + updaters[n] + " shutdown");
                updatersById[updaters[n]].shutdown();
                delete updatersById[updaters[n]];                
            }
        }

        deleteTableByKey = {}; 
        updaterTableByKey = {};
        timerTable = {};
//        updatersById = {};
    }



    this.getStats = function() {
        stats.cacheSize = cache.size();
        stats.numUpdaters = Object.keys(updatersById).length;
        return stats;
    }

    this.getDumpString = function() {

    }

}

module.exports = SmartCache;
module.exports.makeIndexedDBBacking = require('./indexedDBBacking.js');
