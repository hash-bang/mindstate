var _ = require('lodash').mixin(require('lodash-deep'));
var async = require('async-chainable');
var colors = require('colors');
var childProcess = require('child_process');
var fs = require('fs');
var homedir = require('homedir');
var ini = require('ini');
var inquirer = require('inquirer');
var npm = require('npm');
var untildify = require('untildify');

module.exports = function(finish, settings) {
	var iniPath;
	async()
		.then('baseConfig', function(next) {
			mindstate.functions.baseConfig(function(err, baseConfig) {
				if (err) return next(err);
				next(null, baseConfig);
			});
		})
		.then(function(next) {
			// Check plugin config {{{
			if (mindstate.plugins.length) return next(); // At least one installed
			console.log('No Mindstate plugins found');
			inquirer.prompt([
				{
					type: 'checkbox',
					name: 'plugins',
					message: 'What plugins do you want to install',
					choices: [
						{
							name: 'Locations',
							value: 'mindstate-plugin-locations',
						},
						{
							name: 'MongoDB',
							value: 'mindstate-plugin-mongodb',
						},
						{
							name: 'MySQL',
							value: 'mindstate-plugin-mysql',
						},
						{
							name: 'Postfix-Virtual',
							value: 'mindstate-postfix-virtual',
						},
						{
							name: 'Stats',
							value: 'mindstate-plugin-stats',
						},
					],
					default: ['mindstate-plugin-locations', 'mindstate-plugin-stats'],
				},
			], function(answers) {
				if (!answers.plugins.length) return next(); // Do nothing as nothing is selected

				npm.load({global: true}, function(err) {
					if (err) return next(err);
					if (mindstate.verbose) console.log(colors.blue('[NPM]'), 'install', answers.plugins.map(function(i) { return colors.cyan(i) }).join(' '));

					npm.commands.install(answers.plugins, function(err, data) {
						if (err) return next(err);
						if (mindstate.verbose > 2) console.log(colors.blue('[NPM]'), '>', data);

						// Reload plugins
						mindstate.functions.loadPlugins(next);
					});
				});
			});
			// }}}
		})
		.then(function(next) {
			console.log('PLUGINS NOW PERSENT', _.pluck(mindstate.plugins, 'name'));
			next();
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
							name: 'User (' + homedir() + '/.mindstate)',
							value: homedir() + '/.mindstate',
						},
						{
							name: 'Local directory (' + process.cwd() + '/mindstate.config)',
							value: process.cwd() + './mindstate.config',
						},
					],
					default: function() {
						if (mindstate.configFile == '/etc/mindstate') return 0;
						if (/\.mindstate$/.test(mindstate.configFile)) return 1;
						if (/mindstate\.config$/.test(mindstate.configFile)) return 2;
						return 1;
					}(),
				},
				{
					type: 'input',
					name: 'serverAddress',
					message: 'Enter the SSH server you wish to backup to (optional `username@` prefix)',
					default: _.get(mindstate.config, 'server.address') || this.baseConfig.server.address,
				},
				{
					type: 'input',
					name: 'extraDirs',
					message: 'Enter any additional directories to backup seperated with commas',
					default: _.get(mindstate.config, 'locations.dir', []).join(', '),
				},
			], function(answers) {
				iniPath = answers.iniLocation;

				_.merge(mindstate.config, {
					server: {
						address: answers.serverAddress,
						filename: answers.filename,
					},
					locations: {
						enabled: (!! answers.extraDirs),
						dir: (answers.extraDirs ? answers.extraDirs : '')
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
			var parsed = /^(.*)(:.*)$/.exec(mindstate.config.server.address);

			console.log('Attempting SSH key installation...');
			var sshCopyId = childProcess.spawn('ssh-copy-id', [parsed[1]], {stdio: 'inherit'});

			sshCopyId.on('close', function(code) {
				if (code != 0) return next('ssh-copy-id exited with code ' + code);
				return next();
			});
		})
		.then(function(next) {
			var encoded = "# MindState generated INI file\n\n" + ini.encode(mindstate.config);
			fs.writeFile(iniPath, encoded, next);
		})
		.end(function(err) {
			if (!err) console.log(colors.green.bold('MindState setup completed!'));
			finish(err);
		});
};
