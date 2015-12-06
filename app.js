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
	.option('-v, --verbose', 'Be verbose')
	.option('--plugin [plugin]', 'Specify the plugins to use manually. Can be used multiple times', function(i, v) { v.push(i); return v }, [])
	.option('--no-color', 'Disable colors')
	.option('--no-clean', 'Do not delete temp directory after backup')
	.option('--no-upload', 'Skip the upload stage')
	.parse(process.argv);

var plugins = [ // Array of recognised plugins
	require('./plugins/locations'),
	require('./plugins/postfix-virtual'),
	require('./plugins/mysql'),
	require('./plugins/mongodb'),
	require('./plugins/stats'),
].filter(function(plugin) { // If --plugin is specified filter out plugins NOT in that list
	return (!program.plugin.length || _.contains(program.plugin, plugin.name));
});

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
}
// }}}


var commands = {
	backup: require('./commands/backup'),
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
	.end(function(err) {
		if (err) {
			console.log(colors.red('ERROR:'), err.toString());
			return process.exit(1);
		}
		process.exit(0);
	});
