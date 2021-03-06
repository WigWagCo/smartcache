/**
 * THIS TEST FOR IN-BROWSER ONLY
 * Run: [project-root]/test-in-browser.sh
 * Then goto http://localhost:8800/public/backing_store.html
 */


var SmartCache = require('smartcache');
var Promise = require('es6-promise').Promise;
var base32 = require('base32');


var cache = new SmartCache({
	debug_mode: true
});

var double = function(num) {
	return num*2;
}

var VALS = {
'key1' : 5,
'key2' : 50,
'key3' : 500,
'key4' : 1000
};

var externalSetFunc = function(key,val) {
	console.log("externalSetFunc(",key,",",val,")");
	VALS[key] = val;
}
var externalDelFunc = function(key,val) {
	console.log("externalDelFunc(",key,")");
	delete VALS[key];
}

var externalGetFunc = function(key) {
	console.log("externalGetFunc(",key,")");
	return VALS[key]; 
}

var SOMEVAL = base32.randomBase32(8);
var calledEqualityCB = 0;

var SAY = function() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift(">> TEST:");
    if(typeof global == 'object' && global.log)
        log.debug.apply(log,args);
    else
        console.log.apply(console,args);
};


this.backing_store =  {

	'test1' : function(TEST) {

		console.log("backing_store.test1 starting.");

		TEST.ok(true,"All ok.");
		var backing = new SmartCache.makeIndexedDBBacking(cache,"testBackingStore",{debug_mode: true});
		console.log("setting backing...",backing);
		cache.setBacking(backing).then(function(){
			console.log("backing ready!!!!!!!!!!");
			doTest();
		});

		var testUpdater = new cache.Updater(function(cache){
			// this - refers to the Updater
			var setkeys = cache.getWriteReqs(); // The `setkeys` is an array of keys which need to be set by the Updater      
			var getkeys = cache.getReadReqs();  // need to get read by the Updater - and then, set() in the cache
			var delkeys = cache.getDelReqs();
			console.log("in [testUpdater] Updater:",this.id()); // this refers to the Updater
			for(var n=0;n<setkeys.length;n++) {
				console.log("[testUpdater] Updating key",setkeys[n]);
				externalSetFunc(setkeys[n],cache.get(setkeys[n])); // or any other arbritrary magic!
				cache.setComplete(setkeys[n]);  // let the cache know this work was completed
			}
			for(var n=0;n<delkeys.length;n++) {
				console.log("[testUpdater] Deleting key",delkeys[n]);
				externalDelFunc(delkeys[n]); // or any other arbritrary magic!
				cache.del(delkeys[n]);
				cache.setComplete(delkeys[n]);	  
			}
			for(var n=0;n<getkeys.length;n++) {
				console.log("[testUpdater] Setting key",getkeys[n]);
				if(getkeys[n] == "something not here") {
			    cache.setFail(getkeys[n]); // you can mark certain keys as failing. So this 'set' failed.
			                               // this is 'fail fast' - note, any key request not marked 
			                               // with `setComplete(key)` is automatically considered failing
			                               // at the end of the call
			  } else {
			      cache.set(getkeys[n],externalGetFunc(getkeys[n])); // or any other arbritrary magic!
			      //cache.setComplete(keys[n]); // can be done, automatically marked as complete when cache.set is called
			  }
			}

			cache.set('newkey',SOMEVAL);  // the updater may also set new keys during the update
			                            // (opportunistic caching)
			return Promise.resolve(); // should always return a Promise - and should resolve() unless
			                        // critical error happened.
		},
		function(){
			console.trace("[testUpdater] OnShutdown");
		},
		{
			interval: 5000,
			id: 'testUpdater',
			equalityCB: function(key,newval,oldval) {
				console.log("called equalityCB!!!");
				calledEqualityCB++;
				if(newval == oldval) {
					return true;
				} else {	
					return false;
				}
			}
		});


		var doTest = function(){
			SAY("in doTest()");
			
			TEST.ok(true,"OK2");

			cache.setData('key1',3,{
				updater: testUpdater
				,ttl: 2000
			});

			SAY("@key2");

			cache.setData('key2',3,{
				updater: testUpdater
			});

			cache.setData('key3',3,{
				updater: testUpdater
			});

			newKeyTestEvent = null;
			cache.events().on('change',function(key,d,source){
				console.log("got 'change' event",arguments);
				if(key == 'newkey') {
					newKeyTestEvent = {key: key, val: d, source: source };					
					// cache.getData('newkey').then(function(d){
					// })

				}
			});


			// setTimeout(function(){
			// 	cache.setData('key1',6);	
			// },4000);

			// setTimeout(function(){
			// 	cache.setData('key1',7);
			// },6000);
			var RUN = 0;
			var T1 = [];
			T1[0] = 0;
			T1[1] = 0;
			T1[2] = 0;
			T1[3] = 0;
			var printInterval = setInterval(function(){
				console.log("--------------------------");
				var d = cache.getData('key1');
				console.log(" (Promise) key1:",d);
				d.then(function(r){
					console.log("key1:",r);
					T1[1]++;
				},function(){
					T1[1]++;
				}).catch(function(e){
					console.error("@catch:",e);
					TEST.ok(false,"@catch ");
				});
				var d = cache.getData('key2');
				console.log("key2:",d);
				d.then(function(r){
					console.log("key2:",r);
					T1[2]++;
				},function(){
					T1[2]++;
				}).catch(function(e){
					console.error("@catch:",e);
					TEST.ok(false,"@catch ");
				});
				var d = cache.getData('key3');
				console.log("key3:",d);
				d.then(function(r){
					console.log("key3:",r);					
					T1[3]++;
				},function(){
					T1[3]++;
				}).catch(function(e){
					console.error("@catch:",e);
					TEST.ok(false,"@catch ");
				});
				(function(t){
					setTimeout(function(){
						T1[0]++;
						for(var n=1;n<4;n++) {
							TEST.ok(T1[0]==T1[n],"Promises completed key"+n+" for run:"+t);
						}	
					},500);					
				})(RUN);
				console.log("Stats:",cache.getStats());
				RUN++;
			},1500);



			setTimeout(function(){
				console.log("**** removed key1");
				
				var gotEvent = null;
				cache.events().on('del',function(key,source,uid){
					console.log("got 'del' event:",arguments);
					gotEvent = key;
				});

				cache.removeData('key1');
				setTimeout(function(){
					TEST.equal('key1',gotEvent,"delete event");
				},200);

			},10000);


			setTimeout(function(){
				clearInterval(printInterval);
				cache.removeData('key2');
				console.log("clearing all of cache.");
				cache.clear();
				console.log("ok - done.");

	     		var ret = cache.getData('key1').then(function(d){
					TEST.ok(d==undefined,"'key1' should be deleted.");
				},function(){
					TEST.ok(false,"This should never reject");
				});
	     		console.log("RET=",ret);


	     		TEST.ok(newKeyTestEvent && typeof newKeyTestEvent == 'object',"change event");
	     		TEST.equal(newKeyTestEvent.key,'newkey','change Event data ok.');
	     		TEST.equal(newKeyTestEvent.val,SOMEVAL,'Random data from Updater passed.');
	     		TEST.equal(newKeyTestEvent.source,'updater','Source field from Updater passed.');

	     		TEST.ok(calledEqualityCB > 1,"equalityCB is getting called.");

				setTimeout(function(){
					for(var n=1;n<4;n++) {
						TEST.ok(T1[0]==T1[n],"Final test: key"+n+" - Promises completed.");
					}

					TEST.ok(true,"@end.");
					TEST.done();
				},1000);		




			},20000);

		}



	}
}



