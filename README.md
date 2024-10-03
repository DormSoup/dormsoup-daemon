## DormSoup Daemon
Daemon is the component that is responsible for parsing the received emails into events and tags. It receives from an Athena mailscript that is located at `/afs/sipb.mit.edu/project/dormdigest/mail_scripts`.

Send emails to dormdigest@scripts.mit.edu to test.

(You need the `.env` file containing API Key and database url from andiliu)

### Testing locally
First, to authenticate into your email, you need to run
```
npm run relay
```

Then, to test how to parse an email into events, you can run
```
npm run testEmailToEventsPrompt
```
which would authenticate into your inbox, and you can search by email subject via a substring.

or to
```
npm run testEventToTagsPrompt # needs the ssh tunneling in the DormSoup/dormsoup repo because needs access to the database
```
to fetch an event and try to tag it.

### Related Commands on Server
Do all these on the server
```
ssh DormSoup # see DormSoup/dormsoup repo for ssh config setup
```

Check if the DormSoup daemon is alive:
`systemctl status dormsoup.service`

Check the daemon logs:
`journalctl -e -u dormsoup`

Use the PostgreSQL command tool to view events:
```bash
psql

select title, date from "Event";
SELECT MAX("receivedAt") FROM "Email"; # check the latest email received, useful for debugging when daemon died
```
