const AbstractCommand = require('discord-bot-base').AbstractCommand;
const _ = require('lodash');

class UpdateCommand extends AbstractCommand {
    static get name() { return 'update'; }

    static get description() { return 'Update a server id with a new invite code'}

    handle() {
        if (!this.message.isPm()) {
            return false
        }

        return this.responds(
            /^update (\d+) (?:<?)(?:https?:\/\/(?:discord.gg|discordapp.com\/invite)\/)([A-Za-z0-9]+)(?:>?)$/gmi,
            (matches) => {
                let id     = matches[1],
                    server = this.client.servers.get('id', id);

                if (server === null) {
                    this.reply("Bad server id");

                    return;
                }

                if (this.message.author.id !== server.owner.id) {
                    this.reply("You aren't the owner of this server.");

                    return;
                }

                this.reply("Updating " + _.trim(server.name) + " with new invite code: " + matches[2]);
                this.container.get('api').call('/server/' + server.id, 'post', {id: id, invite_code: matches[2]});
            });
    }
}

module.exports = UpdateCommand;