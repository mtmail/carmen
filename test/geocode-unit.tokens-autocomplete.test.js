// Ensures that token replacement casts a wide (unidecoded) net for
// left-hand side of token mapping.

var tape = require('tape');
var Carmen = require('..');
var index = require('../lib/index');
var context = require('../lib/context');
var mem = require('../lib/api-mem');
var queue = require('queue-async');
var addFeature = require('../lib/util/addfeature');

var conf = {
    test: new mem({
        geocoder_tokens: {
            'Street' : 'St'
        },
        maxzoom:6
    }, function() {})
};
var c = new Carmen(conf);
tape('index Aarthy Street', function(t) {
    addFeature(conf.test, {
        id:1,
        properties: {
            'carmen:text':'Aarthy Street',
            'carmen:zxy':['6/32/32'],
            'carmen:center':[0,0]
        }
    }, t.end);
});
tape('Aarthy St => Aarthy Street', function(t) {
    c.geocode('Aarthy St', { limit_verify:1 }, function(err, res) {
        t.deepEqual(res.features[0].place_name, 'Aarthy Street');
        t.end();
    });
});
tape('Aarthy Street => Aarthy Street', function(t) {
    c.geocode('Aarthy Street', { limit_verify:1 }, function(err, res) {
        t.deepEqual(res.features[0].place_name, 'Aarthy Street');
        t.end();
    });
});
tape('Aarthy Stree => Aarthy Street', function(t) {
    c.geocode('Aarthy Stree', { limit_verify:1 }, function(err, res) {
        t.deepEqual(res.features[0].place_name, 'Aarthy Street');
        t.end();
    });
});
tape('index.teardown', function(assert) {
    index.teardown();
    context.getTile.cache.reset();
    assert.end();
});

