var _ = require('lodash').mixin(require('lodash-deep'));
var async = require('async-chainable');
var colors = require('chalk');
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
		// Check plugin config {{{
		.then(function(next) {
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
							value: 'mindstate-plugin-postfix-virtual',
						},
						{
							name: 'Stats',
							value: 'mindstate-plugin-stats',
						},
					],
					default: function() {
						// No plugins installed? Suggest some
						if (!mindstate.plugins.length) {
							console.log('No existing Mindstate plugins found');
							return ['mindstate-plugin-locations', 'mindstate-plugin-stats'];
						}

						// Existing plugins - select them
						return _.map(mindstate.plugins, 'pkgName');
					}(),
				},
			], function(answers) {
				if (!answers.plugins.length) return next(); // Do nothing as nothing is selected

				async()
					.then('npm', function(next) {
						// Load NPM client {{{
						if (mindstate.verbose > 2) console.log(colors.blue('[NPM]'), 'Load NPM');
						npm.load({global: true}, next);
						// }}}
					})
					.then(function(next) {
						// Uninstall unneeded modules {{{
						var uninstallNPMs = _.map(mindstate.plugins.filter(function(plugin) {
							return !_.includes(answers.plugins, plugin.pkgName);
						}), 'pkgName');

						if (!uninstallNPMs.length) {
							if (mindstate.verbose > 2) console.log(colors.blue('[NPM]'), 'nothing to uninstall');
							return next();
						}

						if (mindstate.verbose) console.log(colors.blue('[NPM]'), 'uninstall', uninstallNPMs.map(function(i) { return colors.cyan(i) }).join(' '));

						this.npm.commands.uninstall(uninstallNPMs, function(err, data) {
							if (err) return next(err);
							if (mindstate.verbose > 2) console.log(colors.blue('[NPM]'), '>', data);

							// Reload plugins
							mindstate.functions.loadPlugins(next);
						});
						// }}}
					})
					.then(function(next) {
						// Install new modules {{{
						var installNPMs = answers.plugins.filter(function(plugin) {
							var exists = _.find(mindstate.plugins, {pkgName: plugin});
							if (exists && mindstate.verbose) console.log(colors.blue('[NPM]'), colors.cyan(plugin), 'already installed');
							return !exists;
						});

						if (!installNPMs.length) {
							if (mindstate.verbose) console.log(colors.blue('[NPM]'), 'nothing to install');
							return next();
						}

						if (mindstate.verbose) console.log(colors.blue('[NPM]'), 'install', installNPMs.map(function(i) { return colors.cyan(i) }).join(' '));

						this.npm.commands.install(installNPMs, function(err, data) {
							if (err) return next(err);
							if (mindstate.verbose > 2) console.log(colors.blue('[NPM]'), '>', data);

							// Reload plugins
							mindstate.functions.loadPlugins(next);
						});
						// }}}
					})
					.end(next);
			});
		})
		// }}}
		.then(function(next) {
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
								return _.trimEnd(item, '/');
							})
					},
				});
				next();
			});
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
