var _ = require('lodash');
var async = require('async-chainable');
var fs = require('fs');

module.exports = {
	name: 'acme',
	description: 'A description of what this plugin does',
	backup: function(finish, workspace) {
		async()
			.then(function(next) {
				// Sanity checks {{{
				if (!mindstate.config.acme.enabled) {
					if (mindstate.program.verbose) console.log(colors.grey('Acme backup is disabled'));
					return next('SKIP');
				}
				next();
				// }}}
			})
			.then(function(next) {
				// Do something here - like write a file to the workspace
				fs.writeFile(workspace.dir + '/Hello World.txt', 'Hello World', next);
			})
			.end(finish);
	},
	restore: function(finish, workspace) {
		async()
			.then(function(next) {
				// Sanity checks {{{
				if (!mindstate.config.acme.enabled) {
					if (mindstate.program.verbose) console.log(colors.grey('Acme restore is disabled'));
					return next('SKIP');
				}
				next();
				// }}}
			})
			.then(function(next) {
				// Do something here - like read back the file to the desktop
				fs.createReadStream(workspace.dir + '/hello.txt')
					.pipe(fs.createWriteStream('/tmp/hello.txt'));
				next();
			})
			.end(finish);
	},
	config: function(finish) {
		return finish(null, {
			acme: {
				enabled: true,
			},
		});
	},
};
