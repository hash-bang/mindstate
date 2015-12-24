MindState
=========

**WARNING: MindState is still under the beta testing stage**

```
They knew now that there came a time in the development of every civilisation - which lasted long enough - when its inhabitants could record their mind-state, effectively taking a reading of the person's personality which could be stored, duplicated, read, transmitted and, ultimately, installed into any suitably complex and enabled device or organism. 
- Look to Windward, Iain M. Banks (ISBN: 978-1451621686)
```

Stress-free server backups with Node.

MindState is an easy to use backup program that runs on a server and periodically tarballs resources and transmits them to a SSH server as backups. It can also manage backup volumes so you can retain backup images over a time period.

Backup volumes are created GZip compressed using special Rsync compatible compression so the absolute minimum transmitted data is sent over the wire. Each backup volume is atomic and requires no peer files to reconstruct - it represents a complete tarball of all data.


**Plugins:**

* Locations - backup various manually specified directories
* MySQL - backup MySQL databases
* MongoDB - backup MongoDB databases
* Postfix-Virtual - backup the Postfix virtual email table


**Features:**

* Pluggable interface allowing easy addition of new functionality and backup items
* Management of backup archives from any connected client (see `--list` and `--delete` for examples)
* Delta support - minimal transfers to the server will reduce the bandwidth even if backups are frequent


Installation & Setup
====================

Setting up an SSH server
------------------------
Mindstate requires access to an SSH server in order to dump its generated backup volumes.

Refer to a [Google search](https://encrypted.google.com/search?hl=en&q=setup%20an%20ssh%20server) suffixed with your operating system of choice for instructions.


Installing Mindstate
--------------------

Install MindState using the usual NPM global install:

	npm install -g mindstate

Then setup via:

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
You can perform manual backups, which can be useful for testing by running:

	mindstate --backup

Optionally also specifying `-v` so the CLI is more verbose. Specify multiple times for more verbosity.



Writing MindState plugins
=========================
The MindState plugin system is designed to make it as simple as possible to add functionality.

In essence each plugin, when run is provided with its own workspace - a writable directory on disk - anything placed in this directory is folded into the MindState backup. Each plugin is expected to expose at least a `backup()` function which writes to this location asynchronously, returning execution to the main process on completion.

A plugin can optionally also expose a `restore()` method which performs the reverse action - taking a workspace and restoring the state of the machine from it.


All plugins should be tagged `mindstate` in their respective `package.json` files so the MindState core loader can determine which ones should be loaded on execution.


Frequently Asked Questions
==========================

**How does Mindstate ensure minimal backups?**

Mindstate creates a compressed tarball (like a Zip file if you are not already familiar with them) which is compressed in a specific way to ensure that only the changed part of the data needs to be transfered. While having a slight overhead (approx 1% of file size) this means that if the changes to the backup volume are minimal the bandwidth used is also minimal.


**Since we are created A,B,C backups does this mean I need to retain other backup volumes?**

The A, B, C backup terminology refers to a method of backup volume generation where A type files represent full and complete backups, B represents the differences and C represents the differences between B volumes. While efficient this can be problematic in reconstructing the actual backup image.

Mindstate uses a differnt method where each Mindstate file is atomic and represents a full A style backup. However in order to minimize bandwidth usage it creates what in effect is a B type backup and transmits that using Rsync.


**In detail how does the backup process work?**

The backup process has the following steps:

1. Create a temporary directory on disk to write to (usually in `/tmp`)
2. Load all plugins and perform their respective backup routines in parallel
3. When all plugins finish create a tarball file
4. While creating the tarball stream the contents via `gzip` with Rsync mode enabled
5. Connect to the backup server
6. Ask the backup server to copy the last known backup file to todays timestamp
7. Rsync the created backup volume to the server *over* the file copied in step 6.
8. Rsync should perform a differencial transfer and only upload the minimum changed data compiled into the compressed tarball
