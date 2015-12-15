#!/usr/bin/env node

var _ = require('lodash').mixin(require('lodash-deep'));
var async = require('async-chainable');
var colors = require('colors');
var fs = require('fs');
var ini = require('ini');
var homedir = require('homedir');
var mustache = require('mustache');
var os = require('os');
var program = require('commander');
var requireDir = require('require-dir');
var sftpjs = require('sftpjs');

// Module config {{{
mustache.escape = function(v) { return v }; // Disable Mustache HTML escaping
// }}}

var iniLocations = [
	'/etc/mindstate',
	(homedir() ? homedir() + '/.mindstate' : null),
	'./mindstate.config',
];
var version = require('./package.json').version;

program
	.version(version)
	.option('--backup', 'Perform a backup')
	.option('--dump', 'Dump config')
	.option('--dump-computed', 'Dump config (also showing default values)')
	.option('--list', 'List server backups')
	.option('--setup', 'Initalize config')
	.option('--update', 'Attempt to update the MindState client + plugins')
	.option('--delete [item]', 'Delete a remote mindstate. Can be used multiple times', function(i, v) { v.push(i); return v }, [])
	.option('-v, --verbose', 'Be verbose')
	.option('--plugin [plugin]', 'Specify the plugins to use manually. Can be used multiple times', function(i, v) { v.push(i); return v }, [])
	.option('--no-color', 'Disable colors')
	.option('--no-clean', 'Do not delete temp directory after backup')
	.option('--no-upload', 'Skip the upload stage')
	.parse(process.argv);

// Load plugins, ensure its unique and remove anythng if --plugin is specified
var plugins = _(requireDir('./plugins', {camelcase: true}))
	.map(function(contents, mod) { return contents })
	.uniq(false, 'name')
	.filter(function(plugin, id) {
		return (!program.plugin.length || _.contains(program.plugin, plugin.name));
	})
	.value();

if (!plugins.length) {
	console.log('No plugins to run!');
	process.exit(1);
}

if (program.verbose) console.log('Using plugins:', plugins.map(function(plugin) { return colors.cyan(plugin.name) }).join(', '));

// `config` - saved config (INI ~/.mindstate etc.) {{{
var config = {};
var iniFile = _(iniLocations)
	.compact()
	.find(fs.existsSync);
if (iniFile) {
	config = ini.parse(fs.readFileSync(iniFile, 'utf-8'));
} else if (!program.setup) {
	console.log(colors.red('No settings file found. Use `mindstate --setup` to set one up'));
	process.exit(1);
}
// }}}

// mindstate global object {{{
global.mindstate = {
	config: config,
	configFile: iniFile,
	program: program,
	tempDir: '',
	version: version,
	functions: {},
	plugins: plugins,
};
// }}}

// Global functions {{{
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
				month: _.padLeft((new Date).getMonth(), 2, '0'),
				day: _.padLeft((new Date).getDay(), 2, '0'),
				hour: _.padLeft((new Date).getHours(), 2, '0'),
				minute: _.padLeft((new Date).getMinutes(), 2, '0'),
				second: _.padLeft((new Date).getSeconds(), 2, '0'),
			},
			os: {
				hostname: os.hostname(),
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
			filename: '{{os.hostname}}-{{date.year}}-{{date.month}}-{{date.day}}-{{date.hour}}:{{date.minute}}.tar.gz',
			// password: String, // Paintext password during SSH - do not do this. Use private keys instead
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
		},
	});
}

/**
* Task to load all user config
* This executes the following functions in order:
* 	- baseConfig()
*	- plugins => plugin.config
*	- decorateConfig()
*/
mindstate.functions.loadConfig = function(finish) {
	async()
		.then(function(next) {
			mindstate.functions.baseConfig(function(err, baseConfig) {
				if (err) return next(err);
				mindstate.config = _.defaultsDeep(mindstate.config, baseConfig);
				next();
			});
		})
		.forEach(plugins, function(next, plugin) {
			if (!plugin.config) return nextPlugin();
			plugin.config(function(err, pluginConfig) {
				if (err) return next(err);
				_.defaultsDeep(mindstate.config, pluginConfig);
				next();
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
			next();
			// }}}
		})
		.end(finish);
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
					if (mindstate.program.verbose) console.log(colors.grey('Using local private key'));
					next(null, this.keyContent);
				});
		})
		.then(function(next) {
			this.client = sftpjs()
				.on('error', next)
				.on('ready', function() {
					if (mindstate.program.verbose) console.log(colors.grey('SSH host connected'));
					next();
				})
				.connect({
					host: 'zapp.mfdc.biz',
					username: 'backups',
					password: _.get(mindstate.config, 'server.password', undefined),
					privateKey: this.privateKey || undefined,
					debug: mindstate.program.verbose ? function(d) { // Install debugger to spew SSH output if in verbose mode
						console.log(colors.grey('[SSH]', d));
					} : undefined,
				});
		})
		.end(function(err) {
			if (err) return finish(err);
			finish(null, this.client);
		});
};

/**
* Use an active connection to get a list of files from the server
* @param function finish(err, client) Callback to invoke on completion
* @param object client Active SFTP client
* @param object options Additional options to pass
* @param boolean options.sort What file aspect (same as stat) to sort by (e.g. name, size, date, owner, group)
*/
mindstate.functions.list = function(finish, client, options) {
	var settings = _.defaults(options, {
		sort: 'name',
	});

	client.list('/home/backups/backups', true, function(err, files) {
		if (err) return finish(err);

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
		var compiledPattern = new RegExp(mindstate.config.list.pattern);

		files = files.filter(function(item) {
			return (
				!mindstate.config.list.patternFilter ||
				compiledPattern.test(item.name)
			);
		});
		// }}}

		finish(null, files);
	});
};
// }}}


var commands = {
	backup: require('./commands/backup'),
	delete: require('./commands/delete'),
	dump: require('./commands/dump'),
	dumpComputed: require('./commands/dumpComputed'),
	list: require('./commands/list'),
	setup: require('./commands/setup'),
	update: require('./commands/update'),
};

async()
	.then(function(next) {
		if (!program.update) return next();
		commands.update(next);
	})
	.then(function(next) {
		if (!program.dump) return next();
		commands.dump(next);
	})
	.then(function(next) {
		if (!program.dumpComputed) return next();
		commands.dumpComputed(next);
	})
	.then(function(next) {
		if (!program.setup) return next();
		commands.setup(next);
	})
	.then(function(next) {
		if (!program.backup) return next();
		commands.backup(next);
	})
	.then(function(next) {
		if (!program.list) return next();
		commands.list(next);
	})
	.then(function(next) {
		if (!program.delete || !program.delete.length) return next();
		commands.delete(next);
	})
	.end(function(err) {
		if (err) {
			console.log(colors.red('ERROR:'), err.toString());
			return process.exit(1);
		}
		process.exit(0);
	});
