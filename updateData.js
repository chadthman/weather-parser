var express = require('express');

var app = express.createServer(express.logger());

var dateFormat = require('dateformat')
var http = require('http')

var mongo = require('mongoskin');
var mongodb = require('mongodb');   // just to get the ObjectID type, use the skin for everything else
var ObjectID = require('mongodb').ObjectID;  // Get the objectID type
var latitudes; //-90
var longitudes; //-360


var toType = function (obj) {
    return ({}).toString.call(obj).match(/\s([a-zA-Z]+)/)[1].toLowerCase()
}


var conString = process.env.MONGOHQ_URL || "mongodb://localhost:27017/test"

var db = mongo.db(conString, {
    auto_reconnect: true,
    poolSize: 5,
    safe: false
});

var deleteDocumentsByID = function (documentIDs, callback) {
    db.collection('currentForecast').remove({_id: {$in: documentIDs}}, {}, function (err, result) {
        callback()
    })
}

var findData = function (request, response) {
    db.collection('currentForecast').find({
        "latitude": {$eq: Number(request.query.latitude) - 90},
        "longitude": {$eq: Number(request.query.longitude)}
    }).toArray(function (err, result) {
        if (err) {
            response.send(err)
        }
        else {
            response.send(JSON.stringify(result))
        }
    });
}

app.get('/location', function (request, response) {
    latitudes = [request.query.latitude]
    console.log(latitudes)
    longitudes = [request.query.longitude]
    console.log(longitudes)

    // get a list of all documents currently in the db so we can delete them later
    var existingDocuments = []
    db.collection('currentForecast').find({
        "latitude": {$eq: Number(latitudes[0]) - 90},
        "longitude": {$eq: Number(longitudes[0])}
    }).count(function (err, count) {
        if (err) {
            console.log(err)
        }
        else {
            if (count > 0) {
                db.collection('currentForecast').find({
                    "timestamp": {$lte: new Date(new Date(new Date().getTime() - 360 * 60 * 1000).toISOString())},
                    "latitude": {$eq: Number(latitudes[0]) - 90},
                    "longitude": {$eq: Number(longitudes[0])}
                }).toArray(function (err, result) {
                    if (err) {
                        console.log(err)
                    }
                    else {
                        for (var i = 0; i < result.length; i++) {
                            existingDocuments.push(result[i]._id)
                        }
                    }
                    if (existingDocuments.length > 0) {
                        console.log("Updating data")
                        deleteDocumentsByID(existingDocuments, function () {
                            updateData(function () {
                                findData(request, response)
                            })
                        });
                    } else {
                        console.log("Using existing data")
                        findData(request, response);
                    }
                })
            } else {
                updateData(function () {
                    findData(request, response)
                });
            }
        }
    });
});

var port = process.env.PORT || 1337;
app.listen(port, function () {
    console.log("Listening on " + port);
});

function updateData(callback) {
    var hostName = 'nomads.ncep.noaa.gov'
    var portNumber = 9090
    var pathPrefix = '/dods/'
    var modelName = 'gens'
    var ensembleName = 'gep_all'

    var now = new Date()
    var date = dateFormat(now, 'yyyymmdd', true) // true => UTC
    var hour = dateFormat(now, 'HH', true)
    var h = Number(hour)
    h = Math.floor(h / 6) * 6 - 6
    if (h < 0) {
        h += 24
        now.setDate(now.getDate() - 1)
        date = dateFormat(now, 'yyyymmdd', true)
    }
    var hourString = (h < 10 ? '0' : '' ) + h.toString()

    // see http://nomads.ncep.noaa.gov:9090/dods/gens/gens20130104 (or recent date)
    var variables = ['tmin2m', 'tmax2m', 'apcpsfc', 'csnowsfc', 'crainsfc', 'sunsdsfc']


    var requestsOutstanding = 0
    for (var v = 0; v < variables.length; v++) {
        var variable = variables[v]
        for (var la = 0; la < latitudes.length; la++) {
            var lat = latitudes[la].toString()
            for (var lo = 0; lo < longitudes.length; lo++) {
                var lon = longitudes[lo].toString()

                var queryPath = pathPrefix + modelName + '/' + modelName + date + '/'
                queryPath += ensembleName + '_' + hourString + 'z.ascii?' + variable
                queryPath += '[0:20][1:64][' + lat + ':' + lat + '][' + lon + ':' + lon + ']'
                console.log(queryPath)
                requestsOutstanding++
                var req = http.request({hostname: hostName, port: portNumber, path: queryPath}, function (res) {
                    var data = ''
                    res.on('data', function (chunk) {
                        data += chunk
                    })

                    res.on('end', function () {
                        parseDataString(data, function (parsed) {
                            db.collection('currentForecast').save(parsed, {upsert: true}, function (err, result) {
                                console.log(parsed.variable + ' returned')
                                if (err) {
                                    console.log(err)
                                }

                                if (--requestsOutstanding === 0) {
                                    console.log('last request finished')

                                    // delete documents that were in the db before, so only current ones remain
                                    // deleteDocumentsByID( existingDocuments, function()
                                    // {
                                    callback();
                                    // })
                                }
                            })
                        })
                    })
                })
                req.end()
            }
        }
    }
}


var parseDataString = function (string, callback) {
    var array = string.replace(/\n\n/g, '\n').split(/\n/)

    // first line contains variable and data sizes 'tmin2m, [21][64][1][1]'
    var variable = array[0].split(',')[0]
    console.log('parsing ' + variable)

    // 21 ensembles and 64 time bins are hard-coded in the request and assumed here
    var nEnsembles = 21
    var nTimes = 64

    var values = Array(nTimes)
    for (var t = 0; t < nTimes; t++) {
        values[t] = Array(nEnsembles)
    }

    var l = 1
    var line = ''
    for (var e = 0; e < nEnsembles; e++) {
        for (var t = 0; t < nTimes; t++) {
            line = array[l++]
            if (line === '') {
                break
            } // data broken

            var value = Number(line.split(', ')[1])
            values[t][e] = value
            //console.log( 'time bin ' + t + ', ensemble ' + e + ' has value ' + value + ' for ' + variable )
        }
        if (line === '') {
            break
        }

        line = array[l++]
        if (line !== '') {
            break
        } // data broken
    }

    var data = {variable: variable, values: Array(nTimes)}

    while (line.indexOf('time, ') === -1) {
        line = array[l++]
    }
    line = array[l++]
    var times = line.split(', ')
    if (times.length === nTimes) {
        for (var t = 0; t < nTimes; t++) {
            // day numbers are days since 1 Jan 1, so 1 Jan 2013 => 734869
            var day = Number(times[t]) - 734869
            var wholeDay = Math.floor(day)
            var partialDay = day % 1
            var date = new Date(Date.UTC(2013, 0, 1))
            date.setDate(date.getDate() + wholeDay)
            date.setHours(date.getHours() + 24 * partialDay)
            data.values[t] = {date: date.toISOString(), predictions: values[t]}
        }
    }
    else {
        console.log('didn\'t return the expected number of time bins')
    }

    while (line.indexOf('lat, ') === -1) {
        line = array[l++]
    }
    line = array[l++]
    data.latitude = Number(line)

    while (line.indexOf('lon, ') === -1) {
        line = array[l++]
    }
    line = array[l++]
    data.longitude = Number(line)
    data.timestamp = new Date()

    callback(data)
}


var quitFunction = function () {
    db.close(function () {
        console.log('updateData closed its database')
    })
}

process.on('SIGINT', quitFunction)
process.on('exit', quitFunction)

