var termops = require('./util/termops');
var token = require('./util/token');
var queue = require('queue-async');

// # phrasematch
//
// @param {Object} source a Geocoder datasource
// @param {Array} query a list of terms composing the query to Carmen
// @param {Function} callback called with `(err, features, result, stats)`
module.exports = function phrasematch(source, query, callback) {
    var tokenized = termops.tokenize(token.replaceToken(source.token_replacer, query));
    var getter = source.getGeocoderData.bind(source);
    var loadall = source._geocoder.loadall.bind(source._geocoder);

    // Get all subquery permutations from the query
    var subqueries = termops.permutations(tokenized);

    // Include housenum tokenized permutations if source has addresses
    if (source.geocoder_address) {
        var numTokenized = termops.numTokenize(tokenized, source.version);
        for (var i = 0; i < numTokenized.length; i++) {
            subqueries = subqueries.concat(termops.permutations(numTokenized[i]));
        }
    }

    subqueries = termops.uniqPermutations(subqueries);

    for (var l = 0; l < subqueries.length; l++) {
        var phrase = termops.encodePhrase(subqueries[l], subqueries[l].ender);
        subqueries[l].text = termops.encodableText(subqueries[l]);
        subqueries[l].phrase = phrase;
    }

    loadall(getter, 'freq', [1], function(err) {
        if (err) return callback(err);

        // load up scorefactor used at indexing time.
        // it will be used to scale scores for approximated
        // cross-index comparisons.
        var scorefactor = (source._geocoder.get('freq', 1)||[0])[0] || 1;

        var results = [];

        var l = subqueries.length;
        while (l--) {
            if (!source._dictcache.hasPhrase(subqueries[l])) continue;
            // Augment permutations with matched grids,
            // index position and weight relative to input query.
            subqueries[l].scorefactor = scorefactor;
            subqueries[l].getter = getter;
            subqueries[l].loadall = loadall;
            subqueries[l].cache = source._geocoder;
            subqueries[l].idx = source.idx;
            subqueries[l].zoom = source.zoom;
            subqueries[l].nmask = 1 << source.ndx;
            subqueries[l].bmask = source.bmask;
            subqueries[l].weight = subqueries[l].length / tokenized.length;
            results.push(subqueries[l]);
        }

        return callback(null, results);
    });
};

