var async = require('async-chainable');

module.exports = function(finish) {
	async()
		.then(mindstate.functions.loadConfig)
		.then(function(next) {
			console.log(JSON.stringify(mindstate.config, null, '\t'));
			next();
		})
		.end(finish);
};
