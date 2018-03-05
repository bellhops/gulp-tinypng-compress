var test = process.env.NODE_ENV == 'test',
    through = require('through2'),
    throughParallel = require('through2-concurrent'),
    gutil = require('gulp-util'),
    chalk = gutil.colors,
    request = require('request'),
    path = require('path'),
    util = require('util'),
    fs = require('fs'),
    crypto = require('crypto'),
    minimatch = require('minimatch');

var PLUGIN_NAME = 'gulp-tinypng-compress',
    PluginError = gutil.PluginError;

/**
 * TinyPNG class
 * @todo Move into own library
 */
function TinyPNG(opt, obj) {

    var self = this;

    this.conf = {
        token: null,
        options: {
            key: '',
            sigFile: false,
            sigFolder: false,
            log: false,
            force: false, ignore: false,
            sameDest: false,
            summarize: false,
            parallel: true,
            parallelMax: 5
        }
    };

    this.stats = {
        total: {
            in: 0,
            out: 0
        },
        compressed: 0,
        skipped: 0
    };

    this.init = function(opt) {
        if(typeof opt !== 'object') opt = { key: opt };

        opt = util._extend(this.conf.options, opt);

        if(!opt.key) throw new PluginError(PLUGIN_NAME, 'Missing API key!');

        if(!opt.force) opt.force = gutil.env.force || false; // force match glob
        if(!opt.ignore) opt.ignore = gutil.env.ignore || false; // ignore match glob

        if(opt.summarise) opt.summarize = true; // chin chin, old chap!

        this.conf.options = opt; // export opts

        this.conf.token = new Buffer('api:' + opt.key).toString('base64'); // prep key
        this.hash = new this.hasher(opt.sigFile, opt.sigFolder).populate(); // init hasher class

        return this;
    };

    this.stream = function() {
        var self = this,
            opt = this.conf.options,
            emitted = false;

        return (opt.parallel ? throughParallel : through).obj({maxConcurrency: opt.parallelMax}, function(file, enc, cb) {
            if(self.utils.glob(file, opt.ignore)) return cb();

            if(file.isNull()) {
                return cb();
            }

            if(file.isStream()) {
                this.emit('error', new PluginError(PLUGIN_NAME, 'Streams not supported'));
                return cb();
            }

            if(file.isBuffer()) {
                var hash = null;

                if((opt.sigFile || opt.sigFolder) && !self.utils.glob(file, opt.force)) {
                    var result = self.hash.compare(file);

                    hash = result.hash;

                    if(result.match) {
                        self.utils.log('[skipping] ' + chalk.green('✔ ') + file.relative);
                        self.stats.skipped++;

                        return cb();
                    }
                }

                self.request(file).get(function(err, tinyFile) {
                    if(err) {
                        this.emit('error', new PluginError(PLUGIN_NAME, err));
                        return cb();
                    }

                    self.utils.log('[compressing] ' + chalk.green('✔ ') + file.relative + chalk.gray(' (done)'));
                    self.stats.compressed++;

                    self.stats.total.in += file.contents.toString().length;
                    self.stats.total.out += tinyFile.contents.toString().length;

                    if(opt.sigFile || opt.sigFolder) {
                        var curr = {
                            file: file,
                            hash: hash
                        };

                        if(opt.sameDest) {
                            curr.file = tinyFile;
                            curr.hash = self.hash.calc(tinyFile);
                        }

                        self.hash.update(curr.file, curr.hash);
                    }

                    this.push(tinyFile);

                    return cb();
                }.bind(this)); // maintain stream context
            }
        })
        .on('error', function(err) {
            emitted = true; // surely a method in the stream to handle this?
            self.stats.skipped++;
            self.utils.log(err.message);
        })
        .on('end', function() {
            if(!emitted && opt.sigFile) self.hash.writeFile(); // write sigs after complete
            if(!emitted && opt.sigFolder) self.hash.writeFolder(); // write sigs after complete
            if(opt.summarize) {
                var stats = self.stats,
                    info = util.format('Skipped: %s image%s, Compressed: %s image%s, Savings: %s (ratio: %s)',
                        stats.skipped,
                        stats.skipped == 1 ? '' : 's',
                        stats.compressed,
                        stats.compressed == 1 ? '' : 's',
                        (self.utils.prettySize(stats.total.in - stats.total.out)),
                        (stats.total.in ? Math.round(stats.total.out / stats.total.in * 10000) / 10000 : 0)
                    );

                self.utils.log(info, true);
            }
        });
    };

    this.request = function(file, cb) {
        var self = this;

        return {
            file: file,

            upload: function(cb) {
                var file = this.file;

                request.post({
                    url: 'https://api.tinypng.com/shrink',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Authorization': 'Basic ' + self.conf.token
                    },
                    strictSSL: false,
                    body: file.contents
                }, function(err, res, body) {
                    var data,
                        info = {
                            url: false,
                            count: (res && 'headers' in res && res.headers['compression-count']) || 0
                        };
                    if(err) {
                        err = new Error('Upload failed for ' + file.relative + ' with error: ' + err.message);
                    } else if(body) {
                        try {
                            data = JSON.parse(body);
                        } catch(e) {
                            err = new Error('Upload response JSON parse failed, invalid data returned from API. Failed with message: ' + e.message);
                        }

                        if(!err) {
                            if(data.error) err = this.handler(data, res.statusCode); else if(data.output.url) {
                                info.url = data.output.url;
                            } else err = new Error('Invalid TinyPNG response object returned for ' + file.relative);
                        }
                    } else {
                        err = new Error('No content returned from TinyPNG API for' + file.relative);
                    }

                    cb(err, info);
                }.bind(this));
            },

            download: function(url, cb) {
                request.get({
                    url: url,
                    encoding: null
                }, function(err, res, body) {
                    err = err ? new Error('Download failed for ' + url + ' with error: ' + err.message) : false;
                    cb(err, new Buffer(body));
                });
            },

            handler: function(data, status) {
                return new Error((data.error || 'Unknown') + ' (' + status + '): ' + (data.message || 'No message returned') + ' for ' + file.relative);
            },

            get: function(cb) {
                var self = this,
                    file = this.file;

                self.upload(function(err, data) {
                    if(err) return cb(err, file);

                    self.download(data.url, function(err, data) {
                        if(err) return cb(err, file);

                        var tinyFile = file.clone();
                        tinyFile.contents = data;

                        cb(false, tinyFile);
                    });
                });

                return this;
            }
        };
    };

    this.hasher = function(sigFile, sigFolder) {
        return {
            sigFile: sigFile || false,
            sigFolder: sigFolder || false,
            sigs: {},

            calc: function(file, cb) {
                var md5 = crypto.createHash('md5').update(file.contents).digest('hex');

                cb && cb(md5);

                return cb ? this : md5;
            },
            update: function(file, hash) {
                this.changed = true;
                this.sigs[file.path.replace(file.cwd, '')] = hash;

                return this;
            },
            compare: function(file, cb) {

                var md5 = this.calc(file),
                    filepath = file.path.replace(file.cwd, ''),
                    result = (filepath in this.sigs && md5 === this.sigs[filepath]);

                cb && cb(result, md5);

                return cb ? this : { match: result, hash: md5 };
            },
            mkdir: function(filePath) {
                var dirname = path.dirname(filePath);
                if (fs.existsSync(dirname)) {
                    return true;
                }
                this.mkdir(dirname);
                fs.mkdirSync(dirname);
            },
            populate: function() {
                var data = false;

                if(this.sigFile) {
                    try {
                        data = fs.readFileSync(this.sigFile, 'utf-8');
                        if(data) data = JSON.parse(data);
                    } catch(err) {
                        // meh
                    }

                    if(data) this.sigs = data;
                }

                if(this.sigFolder && fs.existsSync(this.sigFolder)) {
                    try {
                        data = this.walkDir(this.sigFolder).reduce(function(result, item) {
                            var key = Object.keys(item)[0];
                            result[key] = item[key];
                            return result;
                        }, {});
                    } catch(err) {
                        // meh
                    }

                    if(data) this.sigs = data;
                }

                return this;
            },
            walkDir: function(dir) {
                var self = this;
                var results = [];
                var list = fs.readdirSync(dir);
                list.forEach(function (file) {
                    file = dir + '/' + file;
                    var stat = fs.statSync(file);
                    if (stat && stat.isDirectory()) {
                        /* Recurse into a subdirectory */
                        results = results.concat(self.walkDir(file));
                    } else {
                        /* Is a file */
                        var data = {};
                        var key = file.replace(self.sigFolder.replace(/\/$/, ""), '');
                        key = key.substring(0, key.lastIndexOf('.sig'));
                        data[key] = fs.readFileSync(file, 'utf-8');
                        results.push(data);
                    }
                });
                return results;
            },
            writeFile: function() {
                if(this.changed) {
                    try {
                        fs.writeFileSync(this.sigFile, JSON.stringify(this.sigs));
                    } catch(err) {
                        // meh
                    }
                }

                return this;
            },
            writeFolder: function() {
                if(this.changed) {
                    try {
                        var self = this;

                        Object.keys(self.sigs).forEach(function (key) {
                            var file = self.sigFolder.replace(/\/$/, "") + "/" + key.replace(/^\//, "") + '.sig';
                            self.mkdir(file);

                            fs.writeFileSync(file, self.sigs[key]);
                        });
                    } catch (err) {
                        // meh
                    }
                }

                return this;
            }
        };
    };

    this.utils = {
        log: function(message, force) {
            if(self.conf.options.log || force) gutil.log(PLUGIN_NAME, message);

            return this;
        },

        glob: function(file, glob, opt) {
            opt = opt || {};
            var result = false;

            if(typeof glob === 'boolean') return glob;

            try {
                result = minimatch(file.path, glob, opt);
            } catch(err) {}

            if(!result && !opt.matchBase) {
                opt.matchBase = true;
                return this.glob(file, glob, opt);
            }
            return result;
        },

        prettySize: function(bytes) {
            if(bytes === 0) return '0.00 B';

            var pos = Math.floor(Math.log(bytes) / Math.log(1024));
            return (bytes / Math.pow(1024, pos)).toFixed(2) + ' ' + ' KMGTP'.charAt(pos) + 'B';
        }
    };

    return (obj || test) ? this.init(opt) : this.init(opt).stream();
}

module.exports = TinyPNG;
