// Some old school imports to support Node 12
// in the Github Actions runner
const ngrok = require("ngrok");
const express = require("express");
const bodyParser = require("body-parser");
const chalk = require("chalk");
const cp = require("child_process");
const core = require("@actions/core");
const path = require("path");
const axios = require("axios");

console.log(chalk.redBright("Hello from expo-apple-2fa!"));

let expoCli = undefined;
let expoOut = "";
let codeReceived = false;
let isEmailSent = false;

const successMessage =
  "Successfully uploaded the new binary to App Store Connect";

function log(buffer) {
  console.log(buffer);
}

const sendEmail = async (from, to, link, token) => {
  isEmailSent = true;

  try {
    const message = {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from },
      subject: "🔐 Send the code to the CI",
      content: [
        {
          type: "text/plain",
          value: `Hello 👋!\nClick on the following link and enter your code:\n${link}`,
        },
      ],
    };

    await axios({
      method: "POST",
      url: "https://api.sendgrid.com/v3/mail/send",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      data: message,
    });
  } catch (err) {
    console.error(err);
  }
};

// First, start our web server...
const api = express();
api.use(bodyParser.json());

// Handle our routes...
api.get("/", (req, res) => {
  const index = path.join(__dirname, "web/index.html");
  res.sendFile(index);
});

api.post("/", (req, res) => {
  try {
    const { code } = req.body;
    if (code) {
      // TODO: more security
      //
      // For now, let's make sure code is just a 6 digit number
      if (code.length === 6 && /^\d+$/.test(code)) {
        expoCli.stdin.write(code + "\n");
        codeReceived = true;
        res.status(204).send();
      } else {
        res.status(400).send({ error: "Only accepts 6-digit codes." });
      }
    } else {
      res.status(400).send({ error: "No code provided." });
    }
  } catch (exc) {
    console.error(exc);
    res.status(500).send(exc);
  }
});

// Start our API server and ngrok.
// Once we do that, we need to start the publishing process
api.listen(9090, async () => {
  const url = await ngrok.connect(9090);

  log(
    chalk.greenBright("===> When you receive your two factor auth code, visit:")
  );
  log(chalk.whiteBright(`     ${url}`));
  log("");

  // Start work on our Expo project.
  const expoArguments = core.getInput("expo_arguments");
  console.log(
    chalk.blueBright(`===> Running: expo build:ios ${expoArguments}`)
  );

  expoCli = cp.spawn(
    "script",
    [
      "-r",
      "-q",
      "/dev/null",
      `expo build:ios -t archive --non-interactive ${expoArguments}`,
    ],
    {
      env: {
        ...process.env,
        EXPO_APPLE_ID: core.getInput("expo_apple_id"),
        EXPO_APPLE_PASSWORD: core.getInput("expo_apple_password"),
        EXPO_IOS_DIST_P12_PASSWORD: core.getInput("expo_dist_12_password"),
        SPACESHIP_2FA_SMS_DEFAULT_PHONE_NUMBER:
          core.getInput("tfa_phone_number"),
        FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD: core.getInput(
          "app_specific_password"
        ),
      },
      shell: "zsh",
    }
  );

  console.log(`pid: ${expoCli.pid}`);

  // Basic piping experiment
  expoCli.stdout.pipe(process.stdout, { end: false });
  expoCli.stderr.pipe(process.stdout, { end: false });

  const onOutput = (data) => {
    expoOut += data;

    if (codeReceived) return;
    if (
      !isEmailSent &&
      expoOut.includes("Two-factor Authentication (6 digit code) is enabled")
    ) {
      expoCli.stdin.write("\n");
      // Send ngork url to email provided
      sendEmail(
        core.getInput("sendgrid_email_from"),
        core.getInput("sendgrid_email_to"),
        url,
        core.getInput("sendgrid_api_key"),
      );
    }
  };

  expoCli.stdout.on("data", onOutput);
  expoCli.stderr.on("data", onOutput);

  const onExit = (code) => {
    console.log("===> Expo-cli exited with code", code);

    // It seems like the expo-cli is kind of buggy, so as long as we see
    // the success message from Fastlane anywhere in the output, we can
    // successfully exit with a code of zero
    if (expoOut.includes(successMessage)) {
      process.exit(0);
    } else {
      process.exit(code);
    }
  };
  expoCli.on("exit", onExit);
  expoCli.on("close", onExit);
});
