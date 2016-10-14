var _ = require('lodash').mixin(require('lodash-deep'));
var async = require('async-chainable');
var colors = require('chalk');
var homedir = require('homedir');
var fs = require('fs');
var fspath = require('path');
var ini = require('ini');
var moduleFinder = require('module-finder');
var mustache = require('mustache');
var os = require('os');
var requireDir = require('require-dir');
var sshParse = require('ssh-parse');
var sftpjs = require('sftpjs');

// Module config {{{
mustache.escape = function(v) { return v }; // Disable Mustache HTML escaping
// }}}

var mindstate = {
	config: {},
	configFile: null,
	tempDir: '',
	version: require('./package.json').version,
	functions: {},
	plugins: [],
	verbose: 0,
	loadPluginsGlobal: true,
	loadPluginsLocal: true,

	// Core Functionality {{{
	commands: {
		backup: require('./commands/backup'),
		delete: require('./commands/delete'),
		dump: require('./commands/dump'),
		dumpComputed: require('./commands/dumpComputed'),
		list: require('./commands/list'),
		nagios: require('./commands/nagios'),
		setup: require('./commands/setup'),
		tidy: require('./commands/tidy'),
		update: require('./commands/update'),
	},
	// }}}
};

// Global functions {{{
mindstate.functions.getHomeDir = function() {
	var hDir = homedir();
	if (hDir) return hDir;

	// Can't find home dir - use fall backs
	if (process.env.USER) return '/home/' + process.env.USER;

	// No fall backs worked - return null
	return null;
};

mindstate.functions.loadPlugins = function(finish, filter) {
	async()
		.then('modules', function(next) {
			moduleFinder({
				global: mindstate.loadPluginsGlobal,
				local: mindstate.loadPluginsLocal,
				cwd: __dirname,
			}).then(function(modules) {
				next(null, modules.filter(function(mod) {
					return _.startsWith(mod.pkg.name, 'mindstate-');
				}));
			}, next);
		})
		// Check for duplicate modules {{{
		.then(function(next) {
			var seen = {};
			var dupeMods = [];

			this.modules.forEach(function(mod) {
				if (!seen[mod.pkg.name]) {
					seen[mod.pkg.name] = true;
				} else {
					dupeMods.push(mod.pkg.name);
				}
			});

			if (dupeMods.length) {
				return next('Modules discovered twice: ' + dupeMods.join(', ') + '. Remove the duplicates or run with --debug to prevent global modules loading');
			} else {
				return next();
			}
		})
		// }}}
		.forEach('modules', function(next, module) {
			if (module.pkg.name == 'mindstate') return next(); // Ignore this module
			if (!module.pkg) return next('Module doesnt have package information: ' + module.toString());

			if (_.isFunction(filter)) { // Apply filters
				var result = filter(module);
				if (!result) return next();
			}
			try {
				var loadedPlugin = require(fspath.dirname(module.path));
				if (!_.isObject(loadedPlugin)) return next('Plugin ' + module.pkg.name + ' did not return an object');
				if (!loadedPlugin.name) return next('Plugin ' + module.pkg.name + ' did not return a name');
				loadedPlugin.pkgName = module.pkg.name;
				mindstate.plugins.push(loadedPlugin);
				next();
			} catch (e) {
				next('Error loading module ' + module.pkg.name + ' - ' + e.toString());
			}
		})
		.end(function(err) {
			if (err) return finish(err);
			finish(null, mindstate.plugins);
		});
};

/**
* Return the config object after Mustashifying all values
* @param {function} finish(err, config) Callback to fire when completed
*/
mindstate.functions.decorateConfig = function(finish) {
	finish(null, _.deepMapValues(mindstate.config, function(value, path) {
		if (!_.isString(value)) return value;
		return mustache.render(value, {
			date: {
				year: (new Date).getFullYear(),
				month: _.padStart((new Date).getMonth() + 1, 2, '0'),
				day: _.padStart((new Date).getDate(), 2, '0'),
				hour: _.padStart((new Date).getHours(), 2, '0'),
				minute: _.padStart((new Date).getMinutes(), 2, '0'),
				second: _.padStart((new Date).getSeconds(), 2, '0'),
			},
			os: {
				hostname: os.hostname().toLowerCase(),
			},
			tempDir: mindstate.tempDir,
		});
	}));
}

/**
* Return a base config object
*/
mindstate.functions.baseConfig = function(finish) {
	finish(null, {
		client: {
			// Minimum path contents when booting mindstate - this is to protect against minimal Cron environments which often strip out most of these
			paths: ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'],
		},
		server: {
			keyPath: mindstate.functions.getHomeDir() + '/.ssh/id_rsa',
			address: 'backups@zapp.mfdc.biz:~/backups/',
			filename: '{{os.hostname}}-{{date.year}}-{{date.month}}-{{date.day}}-{{date.hour}}:{{date.minute}}:{{date.second}}.tar.gz',
			// password: String, // Plaintext password during SSH - do not do this. Use private keys instead

			// Temporary values - these will be replaced with the parsed contents of server.address via NPM:ssh-parse
			dir: '~',
			username: 'backups',
		},
		locations: {
			dir: [],
		},
		style: {
			date: 'YYYY-DD-MM HH:mm',
			table: {
				chars: {'mid': '', 'left-mid': '', 'mid-mid': '', 'right-mid': ''}, // See https://www.npmjs.com/package/cli-table2#custom-styles
				layout: {'padding-left': 1, 'padding-right': 1, head: ['blue'], border: ['grey'], compact: false},
			}
		},
		list: {
			patternFilter: true,
			pattern: '^(.*)-([0-9]{4})-([0-9]{2})-([0-9]{2})-([0-9]{2}):([0-9]{2}):([0-9]{2}).tar.gz$',
			patternServer: '^<<server>>-([0-9]{4})-([0-9]{2})-([0-9]{2})-([0-9]{2}):([0-9]{2}):([0-9]{2}).tar.gz$',
		},
	});
}

/**
* Task to load all user config
* This executes the following functions in order:
*	- loadIni()
* 	- baseConfig()
*	- plugins => plugin.config
*	- decorateConfig()
*/
mindstate.functions.loadConfig = function(finish) {
	async()
		.then(function(next) {
			mindstate.functions.loadIni(function(err, config) {
				if (err) return next(err);
				mindstate.config = config;
				next();
			});
		})
		.then(function(next) {
			mindstate.functions.baseConfig(function(err, baseConfig) {
				if (err) return next(err);
				mindstate.config = _.defaultsDeep(mindstate.config, baseConfig);
				next();
			});
		})
		.forEach(mindstate.plugins, function(nextPlugin, plugin) {
			if (!plugin.config) return nextPlugin();
			plugin.config(function(err, pluginConfig) {
				if (err) return next(err);
				_.defaultsDeep(mindstate.config, pluginConfig);
				nextPlugin();
			});
		})
		.then(function(next) {
			mindstate.functions.decorateConfig(function(err, newConfig) {
				mindstate.config = newConfig;
				next();
			});
		})
		// Post decoration {{{
		.then(function(next) {
			// cliTable2 is really picky that padding-left / padding-right is an int {{{
			mindstate.config.style.table.layout['padding-left'] = parseInt(mindstate.config.style.table.layout['padding-left']);
			mindstate.config.style.table.layout['padding-right'] = parseInt(mindstate.config.style.table.layout['padding-right']);
			// }}}
			// Populate server.{dir,username} from server.address {{{
			var sshParsed = sshParse(mindstate.config.server.address);
			if (!sshParsed) return next('Invalid server address');
			mindstate.config.server.hostname = sshParsed.hostname;
			mindstate.config.server.dir = _.trimEnd(sshParsed.pathname, '/');
			mindstate.config.server.username = sshParsed.auth;
			// }}}
			next();
		})
		// }}}
		.end(finish);
};


/**
* Load the Mindstate INI file from wherever it is located and return its contents as a parsed object
* @param {function} finish The callback to invoke on completion with an error and object payload
*/
mindstate.functions.loadIni = function(finish) {
	async()
		.set('iniLocations', [
			'/etc/mindstate',
			(mindstate.functions.getHomeDir() ? mindstate.functions.getHomeDir() + '/.mindstate' : null),
			'./mindstate.config',
		])
		.then('iniFile', function(next) {
			next(null, _(this.iniLocations)
				.compact()
				.find(fs.existsSync)
			);
		})
		.then('config', function(next) {
			if (!this.iniFile) return next('No INI file to load');

			mindstate.iniFile = this.iniFile;
			next(null, ini.parse(fs.readFileSync(this.iniFile, 'utf-8')));
		})
		.end(function(err) {
			if (err) return finish(err);
			finish(null, this.config);
		});
};


/**
* Connect to an SSH server and return an SFTP client
* @param {function} finish(err, client) Callback to invoke on completion
*/
mindstate.functions.connect = function(finish) {
	async()
		.then('privateKey', function(next) {
			if (mindstate.config.server.password) return next(); // Use plaintext password instead

			async()
				.set('keyPath', mindstate.config.server.keyPath)
				.then('keyStat', function(next) {
					fs.stat(this.keyPath, next);
				})
				.then('keyContent', function(next) {
					fs.readFile(this.keyPath, next);
				})
				.end(function(err) {
					if (err) return next(err); // Key not found or failed to read
					if (mindstate.verbose) console.log(colors.blue('[SSH]'), 'Using local private key from "' + mindstate.config.server.keyPath + '"');
					next(null, this.keyContent);
				});
		})
		.then(function(next) {
			this.client = sftpjs()
				.on('error', next)
				.on('ready', function() {
					if (mindstate.verbose) console.log(colors.blue('[SSH]'), 'Connected');
					next();
				})
				.connect({
					host: mindstate.config.server.hostname,
					username: mindstate.config.server.username,
					password: _.get(mindstate.config, 'server.password', undefined),
					privateKey: this.privateKey || undefined,
					debug: mindstate.verbose > 2 ? function(d) { // Install debugger to spew SSH output if in `-vvv` verbose mode
						console.log(colors.blue('[SSH]'), d);
					} : undefined,
				});

			// Also attach to raw SSH2 connection client so we catch things like timeouts
			this.client.conn.on('error', next);
		})
		.then('env', function(next) {
			if (mindstate.verbose > 1) console.log(colors.blue('[SSH/env]'), 'Retrieving remote environment config');
			this.client.conn.exec('env', function(err, stream) {
				var envBlock = '';

				if (err) return next(err);
				stream
					.on('close', function(code) {
						if (mindstate.verbose > 2) console.log(colors.blue('[SSH/env]'), 'Exit with code', colors.cyan(code));
						var remoteEnv = {};
						var lineSplitter = /^(.*?)=(.*)$/;
						envBlock.split(/\s*\n\s*/).forEach(function(line) { // Parse all environment strings into remoteEnv
							var bits = lineSplitter.exec(line);
							if (bits) remoteEnv[bits[1]] = bits[2];
						});
						next(err ? 'Env exited with code ' + code : undefined, remoteEnv);
					})
					.on('data', function(data) {
						envBlock += data.toString();
					});
			});
		})
		.end(function(err) {
			if (err) return finish(err);
			this.client.env = this.env; // Glue this.env -> this.client.env
			finish(null, this.client);
		});
};

/**
* Use an active connection to get a list of files from the server
* @param {function} finish(err, client) Callback to invoke on completion
* @param {Object} client Active SFTP client
* @param {Object} [options] Additional options to pass
* @param {boolean} [options.sort] What file aspect (same as stat) to sort by (e.g. name, size, date, owner, group, meta.date). Field accepts dotted notation
* @param {boolean|string} [options.server=false] Limit output to only this server or the specified server
* @param {boolean} [meta=false] Try to extract the server name + date from the filename
*/
mindstate.functions.list = function(finish, client, options) {
	var settings = _.defaults(options || {}, {
		sort: 'name',
		server: false,
		meta: false,
	});

	async()
		.then('realpath', function(next) {
			mindstate.functions.realpath(next, client, mindstate.config.server.dir);
		})
		.then('files', function(next) {
			if (mindstate.verbose > 1) console.log(colors.blue('[SSH/list]'), 'Asking for file listing for path', colors.cyan(this.realpath));
			client.list(this.realpath, true, function(err, files) {
				if (err) return next(err);

				// Convert all dates into JS objects {{{
				files = files.map(function(file) {
					file.date = new Date(file.date);
					return file;
				});
				// }}}

				// Apply sorting (optional) {{{
				if (settings.sort) {
					files.sort(function(a, b) {
						var valA = _.get(a, settings.sort);
						var valB = _.get(b, settings.sort);

						if (valA > valB) {
							return 1;
						} else if (valA < valB) {
							return -1;
						} else {
							return 0;
						}
					});
				}
				// }}}

				// Filter files by mindstate.config.list.patternFilter {{{
				var compiledPattern;
				if (settings.server === true) { // Filter by this server
					compiledPattern = new RegExp(mustache.render('{{=<< >>=}}' + mindstate.config.list.patternServer, {server: os.hostname().toLowerCase()}));
				} else if (settings.server) { // Filter by a server
					compiledPattern = new RegExp(mustache.render('{{=<< >>=}}' + mindstate.config.list.patternServer, {server: settings.server}));
				} else {
					compiledPattern = new RegExp(mindstate.config.list.pattern);
				}

				files = files.filter(function(item) {
					var showFile = (
						!mindstate.config.list.patternFilter ||
						compiledPattern.test(item.name)
					);

					if (mindstate.verbose > 2 && !showFile) console.log(colors.blue('[SSH/list]'), 'Filtering out junk file listing', colors.cyan(item.name));


					return showFile;
				});
				// }}}

				// Extract meta data {{{
				var compiledPattern = new RegExp(mindstate.config.list.pattern);
				files = files.map(function(file) {
					// FIXME: This assumes that the capture groups are exactly in order:
					// server, year, month, day, hour, minute, second
					var bits = compiledPattern.exec(file.name);
					file.meta = {
						server: bits[1],
						date: new Date(bits[2], bits[3], bits[4], bits[5], bits[6], bits[7]),
					};
					return file;
				});
				// }}}

				next(null, files);
			});
		})
		.end(function(err) {
			if (err) return finish(err);
			finish(null, this.files);
		});
};

/**
* Translate a shorthand path into a real one using the servers environment variables
* This really just translates paths like '~/somewhere' into the full path using the HOME variable available from the remote server
* @param {function} finish(err, path) Callback to invoke on completion
* @param {Object} client Active SFTP client
* @param {string} path The path to evaluate
*/
mindstate.functions.realpath = function(finish, client, path) {
	// User HOME + dir style (e.g. '~/dir') - use HOME + USER + path
	if (/^~\//.test(path)) {
		if (!client.env.HOME) return finish('No remote HOME env available');
		if (!client.env.USER) return finish('No remote USER env available');
		return finish(null, client.env.HOME + path.substr(1));
	}

	// User HOME style (e.g. '~user/dir') - use HOME + path
	if (/^~(.*)/.test(path)) {
		return finish('Currently unsupported path style: ' + path);
	}

	// Probably already a real path
	return finish(null, path);
};
// }}}

module.exports = mindstate;
