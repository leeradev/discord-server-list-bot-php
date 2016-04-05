const _            = require('lodash');
const Server       = require('../Model/Server');
const InviteUpdate = require('../Model/InviteUpdate');

const WAIT_TIME = 5;

function makeIterator(array) {
    var currentIndex = -1;

    return {
        current: function () {
            return array[currentIndex];
        },
        done:    function () {
            return currentIndex >= array.length;
        },
        index:   function () {
            return currentIndex;
        },
        prev:    function () {
            currentIndex--;
        },
        next:    function () {
            currentIndex++;
        },
        push:    function (item) {
            array.push(item);
        },
        all:     function () {
            return array;
        }
    }
}

class InviteManager {
    constructor(dispatcher, client, logger) {
        this.dispatcher = dispatcher;
        this.client     = client;
        this.logger     = logger;
        this.lastRun    = Math.round(new Date().getTime() / 1000);
    }

    updateServer(dbServer, botServer) {
        if (!dbServer && !botServer) {
            throw new Error("dbServer and botServer empty")
        }

        if (!dbServer) {
            return Server.findOne({identifier: botServer.id}, (error, server) => {
                if (error) {
                    return this.logger.error(error);
                }

                this.updateServer(server, botServer);
            })
        }

        if (!botServer) {
            botServer = this.client.servers.get('id', dbServer.identifier);
        }

        return new Promise((resolve, reject) => {
            dbServer.save(error => {
                if (error) {
                    this.logger.error(error);

                    return reject();
                }

                //this.logger.debug("Updating server: ", dbServer.name);

                this.client.getInvite(dbServer.inviteCode)
                    .then(invite => resolve)
                    .catch(error => {
                        this.logger.debug("Server's invite code is invalid or expired.");

                        return this.getNewInviteCode(
                            botServer,
                            (invite) => {
                                this.logger.debug(dbServer.name + "'s invite code successfully updated");
                                dbServer.inviteCode = invite.code;
                                dbServer.enabled    = true;

                                return dbServer.save(error => {
                                    if (error) {
                                        this.logger.error(error);
                                    }

                                    return resolve();
                                });
                            },
                            () => {
                                dbServer.inviteCode = undefined;
                                dbServer.enabled    = false;

                                return dbServer.save(error => {
                                    if (error) {
                                        this.logger.error(error);
                                    }

                                    return resolve();
                                });
                            }
                        );
                    })
            });
        });
    }

    updateNextServer() {
        this.lastRun = Math.round(new Date().getTime() / 1000);

        this.servers.next();
        if (this.servers.done()) {
            return this.dispatcher.emit('manager.server.done');
        }

        let dbServer  = this.servers.current(),
            botServer = this.client.servers.get('id', dbServer.identifier);

        if (dbServer.private) {
            return setTimeout(this.updateNextServer.bind(this), 1);
        }

        if (botServer === null) {
            return setTimeout(this.updateNextServer.bind(this), 1);
        }

        this.logger.debug(
            `Server Invite Update: [${this.servers.index()}/${this.servers.all().length - 1}] - ${botServer.id} updating invite.`
        );

        this.updateServer(dbServer, botServer)
            .then(() => setTimeout(this.updateNextServer.bind(this), 1000 * WAIT_TIME))
            .catch(() => setTimeout(this.updateNextServer.bind(this), 1));
    }

    manage() {
        this.client.on('serverCreated', this.checkInviteUpdate.bind(this));


        // Loop through servers in database, check if bot is in the server, also check if invite link is working
        // Loop through servers bot is connected to, check if server is in the database
        // After each server, wait 5 seconds (should be configurable)

        this.dispatcher.on('manager.invite.start', () => {
            this.logger.info("Starting invite manager");
            Server.find({}, (error, servers) => {
                this.servers = makeIterator(_.shuffle(servers));
                this.updateNextServer();
            });
        });

        this.dispatcher.on('manager.invite.done', () => {
            setTimeout(() => {
                this.dispatcher.emit('manager.invite.start');
            }, 30000)
        });

        this.dispatcher.emit('manager.invite.start');

        setInterval(() => {
            let currentTime = Math.round(new Date().getTime() / 1000) - 360;
            if (currentTime - this.lastRun >= 0) {
                this.logger.info("Manager died. Starting up again.");
                this.dispatcher.emit('manager.invite.start');
            }
        }, 5000)
    }

    getNewInviteCode(server, successCallback, unchangedCallback) {
        this.client.getInvites(server)
            .catch(this.logger.error)
            .then(invites => {
                if (!invites || invites.length < 1) {
                    if (!server.defaultChannel) {
                        return unchangedCallback();
                    }

                    return this.client.createInvite(server.defaultChannel.id, {temporary: false})
                        .catch(() => this.checkInviteUpdate(server, unchangedCallback))
                        .then(invite => {
                            if (!invite) {
                                return this.checkInviteUpdate(server, unchangedCallback);
                            }

                            successCallback(invite);
                        });
                }

                let invite = this.getBestInvite(invites);
                if (invite !== null) {
                    return successCallback(invite);
                }
            });
    }

    getBestInvite(invites) {
        let bestInvite = null;
        for (let index in invites) {
            if (!invites.hasOwnProperty(index)) {
                continue;
            }

            let invite = invites[index];
            if (!bestInvite) {
                bestInvite = invite;
            }

            if (invite.temporary || invite.revoked) {
                continue;
            }

            if (invite.channel.name === 'general') {
                bestInvite = invite;
            }
        }

        return bestInvite;
    }

    checkInviteUpdate(server, callback) {
        callback = typeof callback === 'function' ? callback : () => {};

        if (!server.id) {
            console.log(server);
            throw new Error("Server doesn't have an ID?");
        }

        InviteUpdate.find({serverId: server.id}, (error, requests) => {
            let fifteenDaysAgo = new Date();
            fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - 15);

            if (requests.length === 0) {
                let update = new InviteUpdate({serverId: server.id});

                return update.save(error => {
                    if (error) {
                        return this.logger.error(error);
                    }

                    this.sendUpdateRequest(server);
                    callback();
                })
            }

            for (let index in requests) {
                if (!requests.hasOwnProperty(index)) {
                    continue;
                }

                let request = requests[index];
                if (request.insertDate <= fifteenDaysAgo) {
                    request.remove();
                } else {
                    return false;
                }
            }

            this.sendUpdateRequest(server);
            callback();
        });
    }

    sendUpdateRequest(server) {
        this.client.sendMessage(
            server.owner,
            `Hey there! Your server (${_.trim(server.name)}) is currently has either no invite code, or an old invite code for \<http://discordservers.com\>. If you don't update this,
we can't show your server. If you don't wish to recieve these messages, either kick me form your server, or type \`|delist\` in your server.

***Notice: This bot is not affiliated with Discord, and is an unofficial bot. Message \`Aaron\` in Discord Bots, or tweet \`@aequasi\` for help/issues.***

Please reply with a new invite link (preferably a permanent link), in the following format.

\`\`\`
update ${server.id} <new invite url>
\`\`\``
        );
    }
}

module.exports = InviteManager;