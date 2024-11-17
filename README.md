## DormSoup Daemon

The DormSoup Daemon is responsible for parsing received emails into events and tags (the frontend is in [another repo](https://github.com/DormSoup/dormsoup)). It receives emails from an Athena mailscript located at `/afs/sipb.mit.edu/project/dormdigest/mail_scripts`. 

To test, send emails to `dormdigest@scripts.mit.edu`.

(You’ll need the `.env` file containing the API key and database URL from andiliu.)

### (WIP) Testing Locally Without Outlook/Office365

Fetch the email (`.eml` or `.txt` file) you wish to test from

- Our example archive of dormspam emails from GitHub, located at <https://github.mit.edu/sipb/dormdigest-emails>
- Our log of most previously saved emails, located at `/afs/sipb.mit.edu/project/dormdigest/mail_scripts/saved` (ask other SIPB members how to access AFS)
- Download from your favorite email client. On Outlook web, click the "..." button then click on "Save as".

Now run

```bash
npm run parseEmailFromFile study_break.eml
```

This script works to test event date/time parsing, but not to test tag assigning.

For now, you can test the event to tags part by running `npm run testEventToTagsPrompt` as described below,
which needs database credentials, but does not actually need you to be logged in to Outlook/Office365.

### Testing Locally

#### Setting up a Development Database

1. In your `.env` file, make sure you're using the development database URL:

```env
# Production DB (via SSH tunnel)
# DATABASE_URL="postgresql://dormsoup:Hakken23@localhost:5432/dormsoup"

# Development DB (local)
DATABASE_URL="postgresql://dormsoup:Hakken23@localhost:5432/dormsoup_dev"
```

2. Start PostgreSQL if it's not running:

```bash
brew install postgresql@14 # Install PostgreSQL if you don't have it installed
brew services start postgresql@14
```

3. Create the database table and the user
```bash
createdb dormsoup_dev
createuser -s dormsoup
psql -d postgres -c "ALTER USER dormsoup WITH PASSWORD 'Hakken23';"
```

4. Generate your local database table schema if you have none:

```bash
npx prisma migrate dev --name init
```

5. Create and seed a development database:

```bash
npm run create-test
```

This command will:

- Check if your DATABASE_URL ends with 'dev' (for safety)
- Create the database if it doesn't exist
- Push the schema
- Create test data including:
  - A test email sender
  - A test email
  - A test event

To reset your development database:

```bash
dropdb dormsoup_dev
npm run create-test
```

For testing any database-related code, you have two options:

1. Use the production database (via SSH tunnel):

```bash
ssh DormSoup -L 5432:localhost:5432 # or dormdigest.mit.edu, depending on your SSH config
```

Then comment/uncomment the appropriate DATABASE_URL in your `.env` file.

2. Use your local development database:
   Make sure your `.env` file points to your local development database (see above).

#### Testing Email Processing

First, to authenticate into your email, run:

```bash
npm run relay
```

Next, to test parsing an email into events, run:

```bash
npm run testEmailToEventsPrompt
```

This command authenticates into your inbox and allows you to search by email subject using a substring.

For any tests requiring database access, you have two options:

1. Use the production database (via SSH tunnel):

```bash
ssh DormSoup -L 5432:localhost:5432 # or dormdigest.mit.edu, depending on your SSH config
```

Then comment/uncomment the appropriate DATABASE_URL in your `.env` file to use the production database.

2. Use your local development database:
   Make sure your `.env` file points to your local development database (see "Setting up a Development Database" above).

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
