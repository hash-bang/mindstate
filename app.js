#!/usr/bin/env node

var _ = require('lodash').mixin(require('lodash-deep'));
var async = require('async-chainable');
var childProcess = require('child_process');
var cliTable = require('cli-table');
var colors = require('colors');
var copy = require('copy');
var del = require('del');
var fs = require('fs');
var homedir = require('homedir');
var ini = require('ini');
var inquirer = require('inquirer');
var moment = require('moment');
var mustache = require('mustache');
var os = require('os');
var program = require('commander');
var rsync = require('rsync');
var tarGz = require('tar.gz');
var temp = require('temp');
var untildify = require('untildify');

// Module config {{{
mustache.escape = function(v) { return v }; // Disable Mustache HTML escaping
// }}}

var home = homedir();
var iniLocations = [
	'/etc/mindstate',
	(home ? home + '/.mindstate' : null),
	'./mindstate.config',
];

program
	.version(require('./package.json').version)
	.option('--backup', 'Perform a backup')
	.option('--dump', 'Dump config')
	.option('--dump-computed', 'Dump config (also showing default values)')
	.option('--setup', 'Initalize config')
	.option('--list', 'List server backups')
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
].filter(function(plugin) { // If --plugin is specified filter out plugins NOT in that list
	return (!program.plugin.length || _.contains(program.plugin, plugin.name));
});

if (!plugins.length) {
	console.log('No plugins to run!');
	process.exit(1);
}

if (program.verbose) console.log('Using plugins:', plugins.map(function(plugin) { return colors.cyan(plugin.name) }).join(', '));

// Global functions {{{
/**
* Return the config object after Mustashifying all values
* @param function finish(err, config) Callback to fire when completed
*/
function decorateConfig(finish) {
	finish(null, _.deepMapValues(config, function(value, path) {
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
function baseConfig(finish) {
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
				chars: {'mid': '', 'left-mid': '', 'mid-mid': '', 'right-mid': ''}, // See https://github.com/Automattic/cli-table#custom-styles
				layout: {'padding-left': 1, 'padding-right': 1, head: ['blue'], border: ['grey'], compact : false},
			}
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
function loadConfig(finish) {
	async()
		.then(function(next) {
			baseConfig(function(err, baseConfig) {
				if (err) return next(err);
				config = _.defaultsDeep(config, baseConfig);
				next();
			});
		})
		.forEach(plugins, function(next, plugin) {
			if (!plugin.config) return nextPlugin();
			plugin.config(function(err, pluginConfig) {
				if (err) return next(err);
				_.defaultsDeep(config, pluginConfig);
				next();
			});
		})
		.then(function(next) {
			decorateConfig(function(err, newConfig) {
				mindstate.config = config = newConfig;
				next();
			});
		})
		.end(finish);
}
// }}}

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
	program: program,
	tempDir: '',
};
// }}}

// Actions {{{
if (program.dump) {
	// `--dump` {{{
	console.log(JSON.stringify(config, null, '\t'));
	process.exit(0);
	// }}}
} else if (program.dumpComputed) {
	// `--dump-computed` {{{
	async()
		.then(loadConfig)
		.end(function(err) {
			if (err) {
				console.log(colors.red('ERROR:'), err.toString());
				return process.exit(1);
			}
			console.log(JSON.stringify(config, null, '\t'));
			process.exit(0);
		});
	// }}}
} else if (program.setup) {
	// `--setup` {{{
	var iniPath;
	async()
		.then('baseConfig', function(next) {
			baseConfig(function(err, baseConfig) {
				if (err) return next(err);
				next(null, _.defaults(config, baseConfig));
			});
		})
		.then(function(next) {
			// server.address {{{
			inquirer.prompt([
				{
					type: 'list',
					name: 'iniLocation',
					message: 'Where do you want to save this config?',
					choices: [
						{
							name: 'Global (/etc/mindstate)',
							value: '/etc/mindstate',
						},
						{
							name: 'User (' + home + '/.mindstate)',
							value: home + '/.mindstate',
						},
						{
							name: 'Local directory (' + process.cwd() + '/mindstate.config)',
							value: process.cwd() + './mindstate.config',
						},
					],
					default: function() {
						if (iniFile == '/etc/mindstate') return 0;
						if (/\.mindstate$/.test(iniFile)) return 1;
						if (/mindstate\.config$/.test(iniFile)) return 2;
						return undefined;
					}(),
				},
				{
					type: 'input',
					name: 'serverAddress',
					message: 'Enter the SSH server you wish to backup to (optional `username@` prefix)',
					default: config.server.address,
				},
				{
					type: 'input',
					name: 'filename',
					message: 'Enter the prefered filename of the backup tarballs',
					default: config.server.filename,
				},
				{
					type: 'input',
					name: 'extraDirs',
					message: 'Enter any additional directories to backup seperated with commas',
					default: config.locations.dir,
				},
			], function(answers) {
				iniPath = answers.iniLocation;

				_.merge(this.baseConfig, {
					server: {
						address: answers.serverAddress,
						filename: answers.filename,
					},
					locations: {
						enabled: function() { return !! answers.extraDirs }(),
						dir: answers.extraDirs
							.split(/\s*,\s*/)
							.map(function(item) { // Replace ~ => homedir
								return untildify(item);
							})
							.map(function(item) { // Remove final '/'
								return _.trimRight(item, '/');
							})
					},
				});
				next();
			});
			// }}}
		})
		.then(function(next) {
			// Extract server connection string from what might be the full path
			var parsed = /^(.*)(:.*)$/.exec(config.server.address);

			console.log('Attempting SSH key installation...');
			var sshCopyId = childProcess.spawn('ssh-copy-id', [parsed[1]], {stdio: 'inherit'});

			sshCopyId.on('close', function(code) {
				if (code != 0) return next('ssh-copy-id exited with code ' + code);
				return next();
			});
		})
		.then(function(next) {
			var encoded = "# MindState generated INI file\n\n" + ini.encode(config);
			fs.writeFile(iniPath, encoded, next);
		})
		.end(function(err) {
			if (err) {
				console.log(colors.red('ERROR:'), err.toString());
				return process.exit(1);
			}

			console.log(colors.green.bold('MindState setup completed!'));
		});
	// }}}
} else if (program.backup) {
	// `--backup` {{{
	async()
		// Setup tempDir {{{
		.then(function(next) {
			temp.mkdir({prefix: 'mindstate-'}, function(err, dir) {
				if (err) return next(err);
				if (program.verbose) console.log(colors.grey('Using temp directory:', dir));
				mindstate.tempDir = dir;
				next();
			});
		})
		// }}}

		.then(loadConfig)

		// Execute each plugin {{{
		.forEach(plugins, function(next, plugin) {
			plugin.backup(function(err) {
				if (err == 'SKIP') return next(); // Ignore skipped plugins
				return next(err);
			});
		})
		// }}}

		// Create tarball {{{
		.then(function(next) {
			this.tarPath = temp.path({suffix: '.tar'});
			if (program.verbose) console.log(colors.grey('Creating Tarball', this.tarPath));
			new tarGz().compress(mindstate.tempDir, this.tarPath, next);
		})
		// }}}

		// Rsync {{{
		.then(function(next) {
			if (!program.upload) {
				console.log(colors.grey('Upload stage skipped'));
				return next();
			}

			var rsyncInst = new rsync()
				.archive()
				.compress()
				.source(this.tarPath)
				.destination(_.trimRight(config.server.address, '/') + '/' + config.server.filename)
				.output(function(data) {
					console.log(colors.blue('[RSYNC]'), data.toString());
				}, function(err) {
					console.log(colors.blue('[RSYNC]'), colors.red('Error:', data.toString()));
				});

			if (program.verbose) console.log(colors.grey('Begin RSYNC', rsyncInst.command()));

			rsyncInst.execute(next);
		})
		// }}}

		// Cleanup + end {{{
		.end(function(err) {
			// Cleaner {{{
			if (mindstate.tempDir) {
				if (!program.clean) {
					console.log(colors.grey('Cleaner: Skipping temp directory cleanup for', mindstate.tempDir));
				} else {
					if (program.verbose) console.log(colors.grey('Cleaner: Cleaning up temp directory', mindstate.tempDir));
					del.sync(mindstate.tempDir, {force: true});
				}
			}

			if (this.tarPath) {
				if (!program.clean) {
					console.log(colors.grey('Cleaner: Skipping tarball cleanup for', this.tarPath));
				} else {
					if (program.verbose) console.log(colors.grey('Cleaner: Cleaning up tarball', this.tarPath));
					del.sync(this.tarPath, {force: true});
				}
			}
			// }}}

			if (err) {
				console.log(colors.red('ERROR:'), err.toString());
				return process.exit(1);
			}

			console.log(colors.green.bold('MindState backup completed!'));
		});
		// }}}
	// }}}
} else if (program.list) {
	var sftpjs = require('sftpjs');
	async()
		.then(loadConfig)
		.then('privateKey', function(next) {
			if (config.server.password) return next(); // Use plaintext password instead

			async()
				.set('keyPath', home + '/.ssh/id_rsa')
				.then('keyStat', function(next) {
					fs.stat(this.keyPath, next);
				})
				.then('keyContent', function(next) {
					fs.readFile(this.keyPath, next);
				})
				.end(function(err) {
					if (err) return next(null, undefined); // Key not found or failed to read
					if (program.verbose) console.log(colors.grey('Using local private key'));
					next(null, this.keyContent);
				});
		})
		.then(function(next) {
			this.client = sftpjs()
				.on('error', next)
				.on('ready', function() {
					if (program.verbose) console.log(colors.grey('SSH host connected'));
					next();
				})
				.connect({
					host: 'zapp.mfdc.biz',
					username: 'backups',
					password: _.get(config, 'server.password', undefined),
					privateKey: this.privateKey || undefined,
					debug: program.verbose ? function(d) { // Install debugger to spew SSH output if in verbose mode
						console.log(colors.grey('[SSH]', d));
					} : undefined,
				});
		})
		.then('list', function(next) {
			this.client.list('/home/backups/backups', true, next);
		})
		.end(function(err) {
			if (err) {
				console.log(colors.red('ERROR:'), err.toString());
				return process.exit(1);
			}

			// Render table {{{
			var table = new cliTable({
				head: ['#', 'Name', 'Date', 'Size'],
				chars: config.style.table.chars,
				style: config.style.table.layout,
			});

			this.list
				.sort(function(a, b) {
					if (a.name > b.name) {
						return -1;
					} else if (a.name < b.name) {
						return 1;
					} else {
						return 0;
					}
				})
				.forEach(function(file, offset) {
					table.push([
						(offset + 1),
						file.name,
						moment(Date.parse(file.date)).format(config.style.date),
						file.size,
					]);
				});

			console.log(table.toString());
			// }}}

			process.exit(0);
		});
}
// }}}

