var sm = new (require('sphericalmercator'))(),
    ops = require('./util/ops'),
    phrasematch = require('./phrasematch'),
    context = require('./context'),
    termops = require('./util/termops'),
    spatialmatch = require('./spatialmatch'),
    verifymatch = require('./verifymatch'),
    queue = require('queue-async'),
    feature = require('./util/feature'),
    proximity = require('./util/proximity'),
    token = require('./util/token'),
    mu = require('model-un');
var dedupe = require('./util/dedupe');
var errcode = require('err-code');

module.exports = function(geocoder, query, options, callback) {
    options = options || {};
    options.stats = options.stats || false;
    options.debug = options.debug ? {
        id: termops.feature(options.debug),
        extid: options.debug
    } : false;
    options.allow_dupes = options.allow_dupes || false;
    options.indexes = options.indexes || false;

    //Limit query length to 256 characters
    if (query.length > 256) {
        return callback(errcode('Query too long - ' + query.length + '/256 characters', 'EINVALID'));
    }

    // Types option
    if (options.types) {
        if (!Array.isArray(options.types) || options.types.length < 1)
            return callback(errcode('options.types must be an array with at least 1 type', 'EINVALID'));
        var l = options.types.length;
        while (l--) if (!geocoder.bytype[options.types[l]])
            return callback(errcode('Type "' + options.types[l] + '" is not a known type. Must be one of: ' + Object.keys(geocoder.bytype).join(', '), 'EINVALID'));
    }

    // Stacks option
    if (options.stacks) {
        if (!Array.isArray(options.stacks) || options.stacks.length < 1)
            return callback(errcode('options.stacks must be an array with at least 1 stack', 'EINVALID'));
        var l = options.stacks.length;
        while (l--) if (!geocoder.bystack[options.stacks[l]])
            return callback(errcode('Stack "' + options.stacks[l] + '" is not a known stack. Must be one of: ' + Object.keys(geocoder.bystack).join(', '), 'EINVALID'));
    }

    //Proximity is currently not enabled
    if (options.proximity) {
        if (!options.proximity instanceof Array || options.proximity.length !== 2)
            return callback(errcode('Proximity must be an array in the form [lon, lat]', 'EINVALID'));
        if (isNaN(options.proximity[0]) || options.proximity[0] < -180 || options.proximity[0] > 180)
            return callback(errcode('Proximity lon value must be a number between -180 and 180', 'EINVALID'));
        if (isNaN(options.proximity[1]) || options.proximity[1] < -90 || options.proximity[1] > 90)
            return callback(errcode('Proximity lat value must be a number between -90 and 90', 'EINVALID'));
    }

    // check that language code is valid
    if (options.language) {
        if (!mu.hasLanguage(options.language)) return callback(errcode('\'' + options.language + '\' is not a valid language code', 'EINVALID'));
    }

    // Allows user to search for specific ID
    var asId = termops.id(geocoder.byname, query);
    if (asId) return idGeocode(geocoder, asId, options, callback);

    // Reverse geocode: lon,lat pair. Provide the context for this location.
    var tokenized = termops.tokenize(query, true);

    if (tokenized.length > 20) {
        return callback(errcode('Query too long - ' + tokenized.length + '/20 tokens', 'EINVALID'));
    }

    if (tokenized.length === 2 &&
        'number' === typeof tokenized[0] &&
        'number' === typeof tokenized[1]) {
        return reverseGeocode(geocoder, tokenized, options, callback);
    }

    // Forward geocode.
    return forwardGeocode(geocoder, query, options, callback);
};

function idGeocode(geocoder, asId, options, callback) {
    var q = queue(5);
    var extid = asId.dbname + '.' + asId.id;
    var indexes = geocoder.byname[asId.dbname];
    for (var i = 0; i < indexes.length; i++) {
        q.defer(function(source, id, done) {
            feature.getFeatureById(source, id, function(err, data) {
                if (err) return done(err);
                if (!data) return done();
                data.properties['carmen:extid'] = extid;
                done(null, data);
            });
        }, indexes[i], asId.id);
    }
    q.awaitAll(function(err, features) {
        if (err) return callback(err);
        var result = {
            "type": "FeatureCollection",
            "query": [extid],
            "features": []
        };
        for (var i = 0; i < features.length; i++) {
            if (!features[i]) continue;
            var f = ops.toFeature([features[i]]);
            f.relevance = features[i].properties['carmen:score'] || 0;
            result.features.push(f);
        }
        return callback(null, result);
    });
}

function reverseGeocode(geocoder, tokenized, options, callback) {
    if (options.limit && options.types && options.types.length === 1) {
        options.limit = options.limit > 5 ? 5 : options.limit;
    } else if (options.limit > 1) {
        return callback(errcode('limit must be combined with a single type parameter when reverse geocoding', 'EINVALID'));
    }

    // set a maxidx to limit context i/o to only allowed types and their
    // parent features. When a types filter is present this limits maxidx
    // to a lower number. When there's no types filter this allows all
    // indexes to do i/o.
    var maxidx = 0;
    for (var type in geocoder.bytype) {
        if (options.types && options.types.indexOf(type) === -1) continue;
        for (var i = 0; i < geocoder.bytype[type].length; i++) {
            maxidx = Math.max(maxidx, geocoder.bytype[type][i].idx + 1);
        }
    }

    var queryData = {
        type: 'FeatureCollection',
        query: tokenized
    };

    if (options.limit > 1) {
        context(geocoder, queryData.query[0], queryData.query[1], {
            full: false,
            types: options.types,
            stacks: options.stacks,
            limit: options.limit
        }, function(err, feats) {
            if (err) return callback(err);

            var q = queue();

            for (var feat_it = 0; feat_it < feats.length; feat_it++) {
                var coords = feats[feat_it]['carmen:geom'];
                q.defer(context, geocoder, coords[0], coords[1], {
                    full: true,
                    types: options.types,
                    stacks: options.stacks
                });
            }

            q.awaitAll(function(err, contexts) {
                if (err) return callback(err);
                stackContext(null, contexts);
            });
        });
    } else {
        context(geocoder, queryData.query[0], queryData.query[1], {
            full:true,
            maxidx: maxidx,
            types: options.types,
            stacks: options.stacks
        }, function(err, context) {
            if (err) return callback(err);
            splitContext(null, context);
        });
    }

    //If multiple results are being returned, do not split context array
    //and simply format for output. So [poi, poi, poi] => [[poi, place], [poi, place], [poi, place]]
    function stackContext(err, contexts) {
        queryData.features = [];
        var contextIndexes = {};
        for (var contexts_it = 0; contexts_it < contexts.length; contexts_it++) {
            var context = contexts[contexts_it];
            context._relevance = 1;

            // use the display template appropriate to the language, if available
            var index = geocoder.byidx[context[0].properties['carmen:dbidx']];
            var formats = { default: index.geocoder_format };
            if (options.language) formats[options.language] = index['geocoder_format_' + options.language];
            queryData.features.push(ops.toFeature(context, formats, options.language));

            // record index names
            if (options.indexes) contextIndexes[geocoder.byidx[context[0].properties['carmen:dbidx']].id] = true;
        }

        if (options.indexes) queryData.indexes = Object.keys(contextIndexes);

        return callback(null, queryData);
    }

    //If a single result is being returned, split the context array into
    //each of its compenents. So [poi, place, country]
    // => [[poi, place, country], [place, country], [country]]
    function splitContext(err, context) {
        context._relevance = 1;
        queryData.features = [];
        var contextIndexes = {};
        try {
            while (context.length) {
                // filter context results by types if specified.
                if (options.types) {
                    var type = geocoder.byidx[context[0].properties['carmen:dbidx']].type;
                    if (options.types.indexOf(type) === -1) {
                        context.shift();
                        continue;
                    }
                }
                // use the display template appropriate to the language, if available
                var index = geocoder.byidx[context[0].properties['carmen:dbidx']];
                var formats = { default: index.geocoder_format };
                if (options.language) formats[options.language] = index['geocoder_format_' + options.language];
                queryData.features.push(ops.toFeature(context, formats, options.language));

                // record index names
                if (options.indexes) contextIndexes[geocoder.byidx[context[0].properties['carmen:dbidx']].id] = true;

                context.shift();
            }
        } catch (err) {
            return callback(err);
        }

        if (options.indexes) queryData.indexes = Object.keys(contextIndexes);

        return callback(null, queryData);
    }
}

var uniq = require('./util/uniq');
var idmod = Math.pow(2,25);

function forwardGeocode(geocoder, query, options, callback) {
    options.limit = options.limit ? (options.limit > 10 ? 10 : options.limit) : 5;
    query = token.replaceToken(geocoder.replacer, query);
    var queryData = {
        type: 'FeatureCollection',
        query: termops.tokenize(query)
    };
    var zooms = [];
    var grids = [];
    var stats = {};
    var q = queue(5);

    if (options.stats) {
        var stats = {};
        stats.time = +new Date();
        stats.phrasematch = {};
        stats.spatialmatch = {};
        stats.verifymatch = {};
        stats.phrasematch.time = +new Date();
    }

    // set an allowed_idx hash to limit spatialmatch stack i/o only to features
    // that are allowed by options.types.
    options.allowed_idx = {};
    for (var type in geocoder.bytype) {
        if (options.types && options.types.indexOf(type) === -1) continue;
        for (var i = 0; i < geocoder.bytype[type].length; i++) {
            options.allowed_idx[geocoder.bytype[type][i].idx] = true;
        }
    }

    var mp25 = Math.pow(2,25);
    var mp33 = Math.pow(2,33);

    // search runs `geocoder.search` over each backend with `data.query`,
    // condenses all of the results, and sorts them by potential usefulness.
    for (var dbid in geocoder.indexes) q.defer(phrasematch, geocoder.indexes[dbid], query);
    q.awaitAll(function(err, phrasematches) {
        if (err) return callback(err);
        if (options.stats) {
            stats.spatialmatch.time = +new Date;
            stats.phrasematch.time = +new Date - stats.phrasematch.time;
        }
        if (options.debug) {
            options.debug.phrasematch = {};
            for (var idx = 0; idx < phrasematches.length; idx++) {
                var id = geocoder.byidx[idx].id;
                options.debug.phrasematch[id] = {};
                for (var x = 0; x < phrasematches[idx].length; x++) {
                    var matched = phrasematches[idx][x];
                    var phraseText = matched.join(' ');
                    options.debug.phrasematch[id][phraseText] = matched.weight;
                }
            }
        }

        spatialmatch(queryData.query, phrasematches, options, spatialmatchComplete);
    });

    function spatialmatchComplete(err, matched) {
        if (err) return callback(err);

        if (options.stats) {
            stats.spatialmatch.time = +new Date - stats.spatialmatch.time;
            stats.spatialmatch.count = matched.results.length;
            stats.verifymatch.time = +new Date;
        }
        if (options.debug) {
            options.debug.spatialmatch = null;
            for (var x = 0; x < matched.results.length; x++) {
                if (matched.results[x][0].id !== options.debug.id) continue;
                options.debug.spatialmatch = matched.results[x];
                options.debug.spatialmatch_position = x;
            }
        }
        if (matched.waste && matched.waste.length) {
            queryData.waste = matched.waste.map(function(idxSet) {
                return idxSet.map(function(idx) { return geocoder.byidx[idx].id; });
            })
        }

        verifymatch(queryData.query, stats, geocoder, matched, options, function(err, contexts) {
            if (err) return callback(err);
            if (options.stats) {
                stats.verifymatch.time = +new Date - stats.verifymatch.time;
                stats.verifymatch.count = contexts.length;
            }
            if (options.debug) {
                options.debug.verifymatch = null;
                for (var x = 0; x < contexts.length; x++) {
                    if (contexts[x][0].id !== options.debug.extid) continue;
                    options.debug.verifymatch = contexts[x];
                    options.debug.verifymatch_position = x;
                }
            }

            queryData.features = [];
            try {
                for (var i = 0; i < contexts.length; i++) {
                    // use the display template appropriate to the language, if available
                    var index = geocoder.byidx[contexts[i][0].properties['carmen:dbidx']];
                    var formats = { default: index.geocoder_format };
                    if (options.language) formats[options.language] = index['geocoder_format_' + options.language];
                    var feature = ops.toFeature(contexts[i], formats, options.language);
                    queryData.features.push(feature);
                }
            } catch (err) {
                return callback(err);
            }

            if (!options.allow_dupes) queryData.features = dedupe(queryData.features);

            queryData.features = queryData.features.slice(0, options.limit);

            // record index names for each feature context
            if (options.indexes) {
                var contextIndexes = {};
                for (var i = 0; i < queryData.features.length; i++) {
                    for (var context_i = 0; context_i < contexts[i].length; context_i++)
                        contextIndexes[geocoder.byidx[contexts[i][context_i].properties['carmen:dbidx']].id] = true;
                }
                queryData.indexes = Object.keys(contextIndexes);
            }

            if (options.stats) {
                stats.relev = contexts.length ? contexts[0]._relevance : 0;
                stats.time = (+new Date()) - stats.time;
                queryData.stats = stats;
            }
            if (options.debug) queryData.debug = options.debug;
            return callback(null, queryData);
        });
    }
}
