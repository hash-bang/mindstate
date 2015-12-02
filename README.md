MindState
=========

**WARNING: MindState is still under the beta testing stage**


Server backups with Node.

MindState is an easy to use backup program that runs on a server and periodically tarballs resources and transmits them to a SSH server as backups. It can also manage backup volumes so you can retain backup images over a time period.


**Plugins:**

* Locations - backup various manually specified directories
* MySQL - backup MySQL databases
* MongoDB - backup MongoDB databases
* Postfix-Virtual - backup the Postfix virtual email table


Installation & Setup
====================
Install MindState using the usual NPM global install:

	npm install -g mindstate

Then setup:

	mindstate --setup

This should create a configuration file which tells MindState how to behave when run.


Periodic backups
----------------
The easiest way to get MindState to perform periodic backups is to install it as a Cron job:

	crontab -e

... and add the line:

	@daily mindstate --backup


Manual backups
--------------
You can perform manual backups, which can be useful for testing, by running:

	mindstate --backup

Optionally also specifying `-v` so the CLI is more verbose.
