var _ = require('lodash').mixin(require('lodash-deep'));
var async = require('async-chainable');
var colors = require('colors');
var homedir = require('homedir');
var fs = require('fs');
var ini = require('ini');
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

	// Core Functionality {{{
	commands: {
		backup: require('./commands/backup'),
		delete: require('./commands/delete'),
		dump: require('./commands/dump'),
		dumpComputed: require('./commands/dumpComputed'),
		list: require('./commands/list'),
		setup: require('./commands/setup'),
		update: require('./commands/update'),
	},
	// }}}
};

// Global functions {{{
mindstate.functions.loadPlugins = function(finish, filter) {
	var plugins = _(requireDir('./plugins', {camelcase: true}))
		.map(function(contents, mod) { return contents })
		.uniq(false, 'name')
		.filter(filter ? filter : function(plugin) { return true })
		.value();

	mindstate.plugins = plugins;

	finish(null, plugins);

};

/**
* Return the config object after Mustashifying all values
* @param function finish(err, config) Callback to fire when completed
*/
mindstate.functions.decorateConfig = function(finish) {
	finish(null, _.deepMapValues(mindstate.config, function(value, path) {
		if (!_.isString(value)) return value;
		return mustache.render(value, {
			date: {
				year: (new Date).getFullYear(),
				month: _.padLeft((new Date).getMonth() + 1, 2, '0'),
				day: _.padLeft((new Date).getDate(), 2, '0'),
				hour: _.padLeft((new Date).getHours(), 2, '0'),
				minute: _.padLeft((new Date).getMinutes(), 2, '0'),
				second: _.padLeft((new Date).getSeconds(), 2, '0'),
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
		server: {
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
			pattern: '^(.*)-([0-9]{4})-([0-9]{2})-([0-9]{2})-([0-9]{2}):([0-9]{2}).tar.gz$',
			patternServer: '^<<server>>-([0-9]{4})-([0-9]{2})-([0-9]{2})-([0-9]{2}):([0-9]{2}).tar.gz$',
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
		.then(function(next) {
			// Post decoration {{{
			// cliTable2 is really picky that padding-left / padding-right is an int {{{
			mindstate.config.style.table.layout['padding-left'] = parseInt(mindstate.config.style.table.layout['padding-left']);
			mindstate.config.style.table.layout['padding-right'] = parseInt(mindstate.config.style.table.layout['padding-right']);
			// }}}
			// Populate server.{dir,username} from server.address {{{
			var sshParsed = sshParse(mindstate.config.server.address);
			if (!sshParsed) return next('Invalid server address');
			mindstate.config.server.dir = _.trimRight(sshParsed.pathname, '/');
			mindstate.config.server.username = sshParsed.auth;
			// }}}
			next();
			// }}}
		})
		.end(finish);
};


mindstate.functions.loadIni = function(finish) {
	async()
		.set('iniLocations', [
			'/etc/mindstate',
			(homedir() ? homedir() + '/.mindstate' : null),
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
* @param function finish(err, client) Callback to invoke on completion
*/
mindstate.functions.connect = function(finish) {
	async()
		.then('privateKey', function(next) {
			if (mindstate.config.server.password) return next(); // Use plaintext password instead

			async()
				.set('keyPath', homedir() + '/.ssh/id_rsa')
				.then('keyStat', function(next) {
					fs.stat(this.keyPath, next);
				})
				.then('keyContent', function(next) {
					fs.readFile(this.keyPath, next);
				})
				.end(function(err) {
					if (err) return next(null, undefined); // Key not found or failed to read
					if (mindstate.program.verbose) console.log(colors.blue('[SSH]'), 'Using local private key');
					next(null, this.keyContent);
				});
		})
		.then(function(next) {
			this.client = sftpjs()
				.on('error', next)
				.on('ready', function() {
					if (mindstate.program.verbose) console.log(colors.blue('[SSH]'), 'Connected');
					next();
				})
				.connect({
					host: 'zapp.mfdc.biz',
					username: mindstate.config.server.username,
					password: _.get(mindstate.config, 'server.password', undefined),
					privateKey: this.privateKey || undefined,
					debug: mindstate.program.verbose > 2 ? function(d) { // Install debugger to spew SSH output if in `-vvv` verbose mode
						console.log(colors.blue('[SSH]'), d);
					} : undefined,
				});
		})
		.then('env', function(next) {
			if (mindstate.program.verbose > 1) console.log(colors.blue('[SSH/env]'), 'Retrieving remote environment config');
			this.client.conn.exec('env', function(err, stream) {
				var envBlock = '';

				if (err) return next(err);
				stream
					.on('close', function(code) {
						if (mindstate.program.verbose > 2) console.log(colors.blue('[SSH/env]'), 'Exit with code', colors.cyan(code));
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
* @param function finish(err, client) Callback to invoke on completion
* @param object client Active SFTP client
* @param object options Additional options to pass
* @param boolean options.sort What file aspect (same as stat) to sort by (e.g. name, size, date, owner, group)
* @param boolean options.server Limit output to only this server
*/
mindstate.functions.list = function(finish, client, options) {
	var settings = _.defaults(options, {
		sort: 'name',
		server: false,
	});

	async()
		.then('realpath', function(next) {
			mindstate.functions.realpath(next, client, mindstate.config.server.dir);
		})
		.then('files', function(next) {
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
						if (a[settings.sort] > b[settings.sort]) {
							return 1;
						} else if (a[settings.sort] < b[settings.sort]) {
							return -1;
						} else {
							return 0;
						}
					});
				}
				// }}}

				// Filter files by mindstate.config.list.patternFilter {{{
				var compiledPattern;
				if (settings.server) { // Filter by specific server
					compiledPattern = new RegExp(mustache.render('{{=<< >>=}}' + mindstate.config.list.patternServer, {server: os.hostname().toLowerCase()}));
				} else {
					compiledPattern = new RegExp(mindstate.config.list.pattern);
				}

				files = files.filter(function(item) {
					return (
						!mindstate.config.list.patternFilter ||
						compiledPattern.test(item.name)
					);
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
* @param function finish(err, path) Callback to invoke on completion
* @param object client Active SFTP client
* @param string path The path to evaluate
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
