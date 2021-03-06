#!/bin/bash

SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do # resolve $SOURCE until the file is no longer a s    ymlink
    SELF="$( cd -P "$( dirname "$SOURCE" )" && pwd )"
    SOURCE="$(readlink "$SOURCE")"
    [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE" # if $SOURCE was a relative s    ymlink, we need to resolve it relative to the path where the symlink file wa    s located
done

SELF="$( cd -P "$( dirname "$SOURCE" )" && pwd )"

echo "running npm install... need dev dependencies"
pushd $SELF/..
npm install

# if [ ! -d $SELF/node_modules/nodeunit/dist/browser ]; then
# 	cd $SELF/node_modules/nodeunit
# 	make browser
# 	cd $SELF
# fi
cp $SELF/../node_modules/nodeunit/examples/browser/nodeunit.js $SELF/public/js
cp $SELF/../node_modules/nodeunit/share/nodeunit.css $SELF/public
mkdir -p $SELF/tests/public/js
echo "Browserifying..."
# devicejs build: see wigwag-core-modules/APIProxy browserify -r jquery -r ./devicejsBrowser.js:devicejs > ./static/scripts/devicejs.js
#node_modules/browserify/bin/cmd.js -r jsonwebtoken -r es6-promise -r jquery -r underscore -r ./devicejsBrowser.js:devicejs -r ./wwui-utils.js:wwuiutils -r ./devjsUtils.js:devjsUtils -o ../www/js/util-bundle.js
$SELF/../node_modules/browserify/bin/cmd.js -r $SELF/../index.js:smartcache -r $SELF/../base32.js:base32 -r es6-promise -o $SELF/public/js/bundle.js
echo "Done - starting web server on *:8800"
$SELF/../node_modules/http-server/bin/http-server $SELF/../tests -p 8800
popd

