/**
 * THIS TEST FOR IN-BROWSER ONLY
 * Run: [project-root]/test-in-browser.sh
 * Then goto http://localhost:8800/public/backing_store.html
 */


var SmartCache = require('smartcache');

var cache = new SmartCache({
	debug_mode: true
});

var double = function(num) {
	return num*2;
}

var VALS = [];



// var makeIndexDBBacking = function(cache) {
// 	// In the following line, you should include the prefixes of implementations you want to test.
// 	window.indexedDB = window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;
// 	// DON'T use "var indexedDB = ..." if you're not in a function.
// 	// Moreover, you may need references to some window.IDB* objects:
// 	window.IDBTransaction = window.IDBTransaction || window.webkitIDBTransaction || window.msIDBTransaction || {READ_WRITE: "readwrite"}; // This line should only be needed if it is needed to support the object's constants for older browsers
// 	window.IDBKeyRange = window.IDBKeyRange || window.webkitIDBKeyRange || window.msIDBKeyRange;
// 	// (Mozilla has never prefixed these objects, so we don't need window.mozIDB*)




// 	return new cache.Backing(function(){

// 	});

// }





var testUpdater = new cache.Updater(function(val,data,key,cache){
	// this - refers to the Updater
	var self = this;
	return new Promise(function(resolve,reject){
		setTimeout(function(){
			console.log("In [testUpdater (" + self.id() + ":" + self._ref + ")].callback - key",key);
			if(val !== undefined) {
				console.log("got a 'set' command");
				cache.set('key2',val); cache.set('key3',val)
				resolve(val);
				return;
			} else {
				console.log("[testUpdater] was a 'selfUpdate' ")
				if(data !== undefined) {
					console.log("  + has data");
					cache.set('key2',data); 
					cache.set('key3',data+1)
					resolve(double(data));
				} else {
					console.log("  - no data");
					cache.set('key2',5); cache.set('key3',5)
					resolve(5);
				}
			}
		},1000);
	});
},function(val,key,cache){
	console.log("On delete key:",key,"last val was:",val);
},
function(){
	console.trace("[testUpdater] OnShutdown");
},
{
	interval: 5000,
	id: 'testUpdater'
});


cache.setData('key1',3,{
	updater: testUpdater
	,ttl: 2000
});

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
	var d = cache.getData('key1');
	console.log("key1:",d);
	var d = cache.getData('key2');
	console.log("key2:",d);
	var d = cache.getData('key3');
	console.log("key3:",d);
	console.log("Stats:",cache.getStats());
},1000);



setTimeout(function(){
	console.log("**** removed key1");
	cache.removeData('key1');
},10000);


setTimeout(function(){
	clearInterval(printInterval);
	cache.removeData('key2');
	console.log("clearing all of cache.");
	cache.clear();
	console.log("ok - done.");
},20000);

