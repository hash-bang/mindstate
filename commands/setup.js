var _ = require('lodash').mixin(require('lodash-deep'));
var async = require('async-chainable');
var colors = require('colors');
var childProcess = require('child_process');
var fs = require('fs');
var homedir = require('homedir');
var ini = require('ini');
var inquirer = require('inquirer');
var untildify = require('untildify');

module.exports = function(finish) {
	var iniPath;
	async()
		.then('baseConfig', function(next) {
			mindstate.functions.baseConfig(function(err, baseConfig) {
				if (err) return next(err);
				next(null, baseConfig);
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
