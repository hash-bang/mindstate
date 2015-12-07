var _ = require('lodash');
var async = require('async-chainable');
var colors = require('colors');

module.exports = function(finish) {
	async()
		.then(mindstate.functions.loadConfig)
		.then('client', mindstate.functions.connect)
		.then('list', function(next) {
			// Get listing of available mindstates {{{
			if (mindstate.program.verbose) console.log('Requesting list of MindStates');
			this.client.list('/home/backups/backups', true, function(err, list) {
				if (err) return next(err);

				var compiledPattern = new RegExp(mindstate.config.list.pattern);

				list = list
					.sort(function(a, b) {
						if (a.name > b.name) {
							return -1;
						} else if (a.name < b.name) {
							return 1;
						} else {
							return 0;
						}
					})
					.filter(function(item) {
						return (
							!mindstate.config.list.patternFilter ||
							compiledPattern.test(item.name)
						);
					});

				next(null, list);
			});
			// }}}
		})
		.then(function(next) {
			// Filter by items we should delete {{{
			this.list = this.list
				.filter(function(item) {
					return (_.contains(mindstate.program.delete, item.name));
				});
			// }}}
			// FIXME: Would be nice if we could also specify the index or range here using something like [range-parser2](https://www.npmjs.com/package/range-parser2)
			if (!this.list.length) return next('No matching items to delete');
			next();
		})
		.set('deleted', 0)
		.forEach('list', function(nextItem, item) {
			var self = this;
			if (mindstate.program.verbose) console.log('Delete', colors.cyan(item.name));
			this.client.delete('/home/backups/backups' + '/' + item.name, function(err) {
				if (err) return next(err);
				self.deleted++;
				nextItem();
			});
		})
		.then(function(next) {
			if (mindstate.program.verbose) console.log('Deleted', colors.cyan(this.deleted), 'MindStates');
			next();
		})
		.end(finish);
};
