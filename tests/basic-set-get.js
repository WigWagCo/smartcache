// test some timeouts

var SmartCache = require('../index.js');

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

var SOMEVAL = 55;

var testUpdater = new cache.Updater(function(cache){
	// this - refers to the Updater
	var setkeys = cache.getWriteReqs(); // The `setkeys` is an array of keys which need to be set by the Updater      
	var getkeys = cache.getReadReqs();  // need to get read by the Updater - and then, set() in the cache
	var delkeys = cache.getDelReqs();
	console.log("in [testUpdater] Updater:",this.id()); // this refers to the Updater
	console.log("I need to update",keys.length,"keys");
	for(var n=0;n<setkeys.length;n++) {
		console.log("[testUpdater] Updating key",setkeys[n]);
		externalSetFunc(setkeys[n],cache.get(keys[n])); // or any other arbritrary magic!
		cache.setComplete(keys[n]);  // let the cache know this work was completed
	}
	for(var n=0;n<delkeys.length;n++) {
		console.log("[testUpdater] Deleting key",delkeys[n]);
		externalDelFunc(delkeys[n]); // or any other arbritrary magic!
		cache.setComplete(keys[n]);	  
	}
	for(var n=0;n<getkeys.length;n++) {
	console.log("[testUpdater] Updating key",getkeys[n]);
	  if(keys[n] == "something not here") {
	      cache.setFail(keys[n]); // you can mark certain keys as failing. So this 'set' failed.
	                              // this is 'fail fast' - note, any key request not marked 
	                              // with `setComplete(key)` is automatically considered failing
	                              // at the end of the call
	  } else {
	      cache.set(getkeys[n],externalGetFunc(keys[n])); // or any other arbritrary magic!
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
	id: 'testUpdater'
});


// nodeunit boiler plate:
if(module)
	module.exports = {};
else {
	var module = {};
	module.exports = {};
}
// nodeunit does not report exceptions
// that's silly, but here is the fix:
module.exports.basic_get_set = function(test) {
	if(global.process) {
		process.on('uncaughtException', function(err) {
		  	console.error("EXCEPTION:",err.stack);
			test.ok(false,"EXCEPTION:"+err.stack);  
			test.done();
		});		
	}
// end boiler plate.
 
	var SmartCache = require('../index.js');

	var cache = new SmartCache({
		debug_mode: true
	});




	cache.setData('key1',3,{
		updater: testUpdater
		,ttl: 2000
	}).then(function(){
		// test.ok(true,"set fulfilled.");
	})

	cache.setData('key2',3,{
		updater: testUpdater
	});

	cache.setData('key3',3,{
		updater: testUpdater
	});

	// setTimeout(function(){
	// 	cache.setData('key1',6);	
	// },4000);

	// setTimeout(function(){
	// 	cache.setData('key1',7);	
	// },6000);


	var printInterval = setInterval(function(){
		console.log("--------------------------");
		var d = cache.getData('key1').then(function(d){
			console.log("OK, key1=",d)
		});
		console.log("key1:",d);
		var d = cache.getData('key2').then(function(d){
			console.log("OK, key2=",d)		
		});
		console.log("key2:",d);
		var d = cache.getData('key3').then(function(d){
			console.log("OK, key3=",d)		
		});
		console.log("key3:",d);
		console.log("Stats:",cache.getStats());
	},1000);



	setTimeout(function(){
		console.log("**** removed key1");
		cache.removeData('key1').then(function(){
			test.ok(true,"test removeData()");
			cache.getData('key1').then(function(d){
				test.ok(d==undefined,"Test deletion.");
			});			
		},function(){
			test.ok(false,"Failed to removeData()");
		})

	},10000);

//			test.done();

	setTimeout(function(){
		clearInterval(printInterval);
		cache.removeData('key2');
		cache.getData('key2').then(function(d){
			test.ok(d==undefined,"Test deletion.");
		});
		console.log("clearing all of cache.");
		cache.clear();
		cache.getData('key3').then(function(d){
			test.ok(d==undefined,"Test clear()");
		});
		setTimeout(function(){
			console.log("Wait for test completion.");
			test.done();
		},500)
		console.log("ok - done.");
	},20000);







}

