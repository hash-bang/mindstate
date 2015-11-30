#!/usr/bin/env node

var _ = require('lodash');
var async = require('async-chainable');
var colors = require('colors');
var fs = require('fs');
var homedir = require('homedir');
var ini = require('ini');
var inquirer = require('inquirer');
var program = require('commander');
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
	.option('--dump', 'Dump config and exit')
	.option('--setup', 'Initalize config')
	.option('-v, --verbose', 'Be verbose')
	.option('--no-color', 'Disable colors')
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
			], function(answers) {
				iniPath = answers.iniLocation;
				_.merge(config, {
					server: {
						address: answers.serverAddress,
					},
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
}
// }}}
