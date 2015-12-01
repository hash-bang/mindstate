#!/usr/bin/env node

var _ = require('lodash');
var async = require('async-chainable');
var colors = require('colors');
var copy = require('copy');
var del = require('del');
var fs = require('fs');
var homedir = require('homedir');
var ini = require('ini');
var inquirer = require('inquirer');
var program = require('commander');
var tarGz = require('tar.gz');
var temp = require('temp');
var untildify = require('untildify');
var util = require('util');

var home = homedir();
var iniLocations = [
	'/etc/mindstate',
	(home ? home + '/.mindstate' : null),
	'./mindstate.config',
];

var version = '0.1.0'; // Version (auto-bump)

program
	.version(version) // FIXME: Correct with right version via Gulp (can't use require('package.json') as it upsets nexe)
	.option('--backup', 'Perform a backup')
	.option('--dump', 'Dump config and exit')
	.option('--setup', 'Initalize config')
	.option('-v, --verbose', 'Be verbose')
	.option('--no-color', 'Disable colors')
	.option('--no-clean', 'Do not delete temp directory after backup')
	.parse(process.argv);


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

// Actions {{{
if (program.dump) {
	// `--dump` {{{
	console.log(util.inspect(config, {depth: null, colors: true}));
	process.exit();
	// }}}
} else if (program.setup) {
	// `--setup` {{{
	var iniPath;
	async()
		.then(function(next) {
			// server.address {{{
			inquirer.prompt([
				{
					type: 'list',
					name: 'iniLocation',
					message: 'Where do you want to save this config?',
					choices: [
						{
							key: 'global',
							name: 'Global (/etc/mindstate)',
							value: '/etc/mindstate',
						},
						{
							key: 'user',
							name: 'User (' + home + '/.mindstate)',
							value: home + '/.mindstate',
						},
						{
							key: 'dirLocal',
							name: 'Local directory (' + process.cwd() + '/mindstate.config)',
							value: process.cwd() + './mindstate.config',
						},
					],
				},
				{
					type: 'input',
					name: 'serverAddress',
					message: 'Enter the SSH server you wish to backup to (optional `username@` prefix)',
					default: 'backups@zapp.mfdc.biz',
				},
				{
					type: 'input',
					name: 'extraDirs',
					message: 'Enter any additional directories to backup seperated with commas',
				},
			], function(answers) {
				iniPath = answers.iniLocation;

				_.merge(config, {
					server: {
						address: answers.serverAddress,
					},
					locations: {
						dir: answers.extraDirs
							.split(/\s*,\s*/)
							.map(function(item) { // Replace ~ => homedir
								return untildify(item);
							})
							.map(function(item) { // Remove final '/'
								return _.trimRight(item, '/');
							})
					}
				});
				next();
			});
			// }}}
		})
		.then(function(next) {
			// FIXME: Check server accessibility / creds
			next();
		})
		.then(function(next) {
			var encoded = "# MindState generated INI file\n\n" + ini.encode(config);
			fs.writeFile(iniPath, encoded, next);
		})
		.end(function(err) {
			if (err) {
				console.log(colors.red(err.toString()));
				return process.exit(1);
			}
			console.log(colors.green.bold('MindState setup completed!'));
		});
	// }}}
} else if (program.backup) {
	// `--backup` {{{
	async()
		// Setup tempDir {{{
		.then('tempDir', function(next) {
			temp.mkdir({prefix: 'mindstate-'}, next);
		})
		.then(function(next) {
			if (program.verbose) console.log(colors.grey('Using temp directory:', this.tempDir));
			next();
		})
		// }}}
		
		// config.locations.dir - additional dir locations to backup {{{
		.then(function(next) {
			if (!_.has(config, 'locations.dir') || !config.locations.dir.length) {
				if (program.verbose) console.log(colors.grey('No additional locations to backup'));
				return next();
			}

			async()
				.set('tempDir', this.tempDir)
				.forEach(config.locations.dir, function(next, dir) {
					var self = this;
					copy.dir(dir, this.tempDir + '/files/' + dir, next);
				})
				.end(function(err, files) {
					if (err) return next(err);
					if (program.verbose) console.log(colors.blue('[File]'), colors.cyan(config.locations.dir.length), 'paths copied');
					next();
				});
		})
		// }}}

		// Create tarball {{{
		.then(function(next) {
			this.tarPath = temp.path({suffix: '.tar'});
			if (program.verbose) console.log(colors.grey('Creating Tarball', this.tarPath));
			new tarGz().compress(this.tempDir, this.tarPath, next);
		})
		// }}}

		// Cleanup + end {{{
		.end(function(err) {
			// Cleaner {{{
			if (this.tempDir) {
				if (!program.clean) {
					console.log(colors.grey('Skipping temp directory cleanup for', this.tempDir));
				} else {
					if (program.verbose) console.log(colors.grey('Cleaning up temp directory', this.tempDir));
					del.sync(this.tempDir, {force: true});
				}
			}

			if (this.tarPath) {
				if (!program.clean) {
					console.log(colors.grey('Skipping tarball cleanup for', this.tarPath));
				} else {
					if (program.verbose) console.log(colors.grey('Cleaning up tarball', this.tarPath));
					del.sync(this.tempDir, {force: true});
				}
			}
			// }}}

			if (err) {
				console.log(colors.red(err.toString()));
				return process.exit(1);
			}

			console.log(colors.green.bold('MindState backup completed!'));
		});
		// }}}
	// }}}
}
// }}}
