## DormSoup Daemon

The DormSoup Daemon is responsible for parsing received emails into events and tags. It receives emails from an Athena mailscript located at `/afs/sipb.mit.edu/project/dormdigest/mail_scripts`.

To test, send emails to `dormdigest@scripts.mit.edu`.

(You’ll need the `.env` file containing the API key and database URL from andiliu.)

### Testing Locally

First, to authenticate into your email, run:
```bash
npm run relay
```

Next, to test parsing an email into events, run:
```bash
npm run testEmailToEventsPrompt
```
This command authenticates into your inbox and allows you to search by email subject using a substring.

For any tests requiring database access, use reverse SSH tunneling to connect to the server:
```bash
ssh DormSoup -L 5432:localhost:5432 # or dormdigest.mit.edu, depending on your SSH config
```
Be aware that you’ll be connected to our production database (we currently don’t have a separate dev environment), so proceed with caution.

You can then test database-related code, such as:
```bash
npm run testEventToTagsPrompt
```
This will fetch an event and attempt to tag it.

For testing any custom feature outside of the email-to-event or event-to-tag pipeline, use the `script/oneOffTask.ts` file (a throwaway file for testing). You can also copy useful code from `testEmailToEventsPrompt.ts` or `testEventToTagsPrompt.ts` if needed.

### Testing on the Server

Once you've tested locally, you might want to deploy your code on the server to test it live.

1. SSH into the server, navigate to the `daemon` folder, pull your changes (I know, risky), and restart the daemon service using:
   ```bash
   sudo systemctl restart dormsoup.service
   ```

2. You may need to switch to the `sipb` user for sudo operations:
   ```bash
   su sipb
   ```
   Ask andiliu for the password.

After restarting the daemon and making your changes live, there are two ways to test it:

#### 1. Testing by Sending an Email (Easy)
Copy the content of a dormspam email (do not simply forward it — our deduplication logic will ignore the email) and send it to `dormdigest@scripts.mit.edu`.

#### 2. Testing by Using the Mailscript Directly (Advanced)

In another terminal, SSH into your Athena locker:
```bash
ssh <YOUR_KERB>@athena.dialup.mit.edu
```
Navigate to the SIPB locker:
```bash
/afs/sipb.mit.edu/project/dormdigest/mail_scripts
```
Run this command to see the scripts:
```bash
aklog sipb
```

You’ll find a script named `send_to_dormsoup.py`. Pipe an email (downloaded as a `.eml` file from your mail client) into the stdin of this script. **Do not** use `send_to_backend.py`, as that sends to the DormDigest backend, not DormSoup.

### Example Server Commands

Note that all these commands should be run on the server. You can connect to the server using this command:
```bash
ssh DormSoup # see the DormSoup/dormsoup repo for SSH config setup
```

- Check if the DormSoup daemon is running:
  ```bash
  systemctl status dormsoup.service
  ```

- View the daemon logs:
  ```bash
  journalctl -e -u dormsoup
  ```

- Use the PostgreSQL command-line tool to view events:
  ```bash
  psql
  ```

  Example queries:
  ```sql
  SELECT title, date FROM "Event";
  SELECT MAX("receivedAt") FROM "Email";  # check the latest email received, useful for debugging if the daemon is down
  ```
