const http = require('http');

const URL = 'http://localhost:3000/api/health';
const TIMEOUT_MS = 10000;
const INTERVAL_MS = 300;

function check(resolve, reject, start) {
  http.get(URL, (res) => {
    if (res.statusCode === 200) {
      resolve(0);
    } else {
      retry(resolve, reject, start);
    }
  }).on('error', () => {
    retry(resolve, reject, start);
  });
}

function retry(resolve, reject, start) {
  if (Date.now() - start > TIMEOUT_MS) {
    reject(new Error('Health check timeout'));
    return;
  }
  setTimeout(() => check(resolve, reject, start), INTERVAL_MS);
}

new Promise((resolve, reject) => check(resolve, reject, Date.now()))
  .then(() => process.exit(0))
  .catch(() => process.exit(1));


