const express = require('express');
const multer = require('multer');
const path = require('path');
const https = require('https');
const cors = require('cors');

const app = express();
const PORT = 8080;

// -------- JSONBIN.IO CONFIGURATION ----------
const JSONBIN_BIN_ID = '69f16490856a68218984fb7e';
const JSONBIN_ACCESS_KEY = '$2a$10$ArZphpxn9dQsIKONyzHFZ.rx4ChwP5Jnm6YiM1ZPMECPTfdPBTmdu';
const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;
const JSONBIN_HEADERS = {
  'Content-Type': 'application/json',
  'X-Master-Key': JSONBIN_ACCESS_KEY
};

// --------- MIDDLEWARE ----------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// --------- MULTER CONFIG (memory storage for Base64 receipts) ----------
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 } // 5 MB
});

// --------- JSONBIN HELPERS ----------

// Promisified HTTPS request
function jsonbinRequest(method, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      method,
      headers: JSONBIN_HEADERS
    };

    const req = https.request(JSONBIN_URL, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const json = JSON.parse(data);
            resolve(json.record); // bin data is in .record
          } catch (e) {
            reject(new Error('Invalid JSON from jsonbin'));
          }
        } else {
          reject(new Error(`jsonbin error ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', (err) => reject(err));

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// Get complete data from the bin
async function getBinData() {
  try {
    return await jsonbinRequest('GET');
  } catch (err) {
    // If bin empty or not found, return empty structure
    return { forms: [], messages: [], logs: [] };
  }
}

// Update the entire bin with new data
async function updateBinData(data) {
  return await jsonbinRequest('PUT', data);
}

// --------- INITIALIZE BIN (if empty) ----------
(async () => {
  try {
    const existing = await getBinData();
    if (!existing.forms || !existing.messages || !existing.logs) {
      await updateBinData({ forms: [], messages: [], logs: [] });
      console.log('✅ Initialized empty bin structure');
    } else {
      console.log('✅ Bin already contains data');
    }
  } catch (err) {
    console.error('⚠️ Could not initialise bin:', err.message);
  }
})();

// --------- ADMIN CREDENTIALS ----------
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'favourvisa2025';

// --------- USER ENDPOINTS ----------

// Save user info
app.post('/api/save-user', async (req, res) => {
  try {
    const { fullName, phone, email, country, jobType } = req.body;
    if (!fullName || !phone || !email) {
      return res.status(400).json({ error: 'All fields required' });
    }

    const data = await getBinData();
    const forms = data.forms;

    const newEntry = {
      id: Date.now(),
      fullName,
      phone,
      email,
      country: country || 'Nigeria',
      jobType: jobType || 'Not specified',
      timestamp: new Date().toISOString(),
      status: 'pending_payment',
      receiptUploaded: false,
      receiptBase64: null,               // will hold the data URL when uploaded
      paymentDate: null,
      portalToken: Buffer.from(email + Date.now()).toString('base64').substring(0, 24),
      whatsappNumber: phone,
      lastLogin: null,
      notes: []
    };

    forms.push(newEntry);
    data.forms = forms;

    // Add log
    data.logs.unshift({
      id: Date.now(),
      timestamp: new Date().toISOString(),
      action: 'USER_REGISTERED',
      admin: 'system',
      details: `New user registered: ${fullName} (${email})`,
      ip: '127.0.0.1'
    });
    if (data.logs.length > 1000) data.logs = data.logs.slice(0, 1000);

    await updateBinData(data);
    res.json({ success: true, message: 'User saved', entryId: newEntry.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Upload receipt
app.post('/api/upload-receipt', upload.single('receipt'), async (req, res) => {
  try {
    const { email, fullName, phone } = req.body;
    if (!req.file) {
      return res.status(400).json({ error: 'Receipt file required' });
    }

    const data = await getBinData();
    const forms = data.forms;
    const userIndex = forms.findIndex(f => f.email === email && f.status === 'pending_payment');

    if (userIndex === -1) {
      return res.status(404).json({ error: 'User not found or already processed' });
    }

    // Convert image to base64 data URL
    const mime = req.file.mimetype;
    const base64 = req.file.buffer.toString('base64');
    const dataUrl = `data:${mime};base64,${base64}`;

    forms[userIndex].status = 'approved';
    forms[userIndex].receiptUploaded = true;
    forms[userIndex].receiptBase64 = dataUrl;
    forms[userIndex].paymentDate = new Date().toISOString();
    data.forms = forms;

    // Log
    data.logs.unshift({
      id: Date.now(),
      timestamp: new Date().toISOString(),
      action: 'PAYMENT_VERIFIED',
      admin: 'system',
      details: `Payment verified for ${fullName} (${email}) - Receipt uploaded`,
      ip: '127.0.0.1'
    });
    if (data.logs.length > 1000) data.logs = data.logs.slice(0, 1000);

    await updateBinData(data);

    res.json({
      success: true,
      message: 'Receipt uploaded successfully',
      email,
      fullName
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get dashboard data
app.get('/api/dashboard', async (req, res) => {
  try {
    const { token, email } = req.query;
    const data = await getBinData();
    const forms = data.forms;
    const user = forms.find(f => f.email === email && f.portalToken === token);

    if (!user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Update last login
    user.lastLogin = new Date().toISOString();
    data.forms = forms; // forms array updated in place
    await updateBinData(data);

    res.json({
      fullName: user.fullName,
      email: user.email,
      phone: user.phone,
      country: user.country,
      jobType: user.jobType,
      status: user.status,
      applicationDate: user.timestamp,
      paymentDate: user.paymentDate || 'Pending',
      receiptUrl: user.receiptBase64 ? `/api/receipt/${user.id}` : null,
      whatsappNumber: user.whatsappNumber,
      lastLogin: user.lastLogin
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Serve a receipt image by user ID
app.get('/api/receipt/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const data = await getBinData();
    const user = data.forms.find(f => f.id === id);

    if (!user || !user.receiptBase64) {
      return res.status(404).send('Receipt not found');
    }

    // data URL format: data:image/png;base64,xxxx
    const parts = user.receiptBase64.split(',');
    const mime = parts[0].split(':')[1].split(';')[0];
    const buffer = Buffer.from(parts[1], 'base64');

    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(buffer);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// --------- USER MESSAGES ----------

// Get messages for a specific user
app.get('/api/user/messages', async (req, res) => {
  try {
    const { email } = req.query;
    const data = await getBinData();
    const allMessages = data.messages;
    const userMessages = allMessages.filter(m =>
      m.userIds.includes('all') || m.userIds.includes(email)
    );
    res.json(userMessages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// User replies to a message
app.post('/api/user/reply-message', async (req, res) => {
  try {
    const { messageId, userEmail, userName, reply } = req.body;
    const data = await getBinData();
    const messages = data.messages;
    const msgIndex = messages.findIndex(m => m.id === parseInt(messageId));

    if (msgIndex === -1) {
      return res.status(404).json({ error: 'Message not found' });
    }

    if (!messages[msgIndex].replies) messages[msgIndex].replies = [];
    messages[msgIndex].replies.push({
      id: Date.now(),
      userEmail,
      userName,
      reply,
      timestamp: new Date().toISOString()
    });

    // Log
    data.logs.unshift({
      id: Date.now(),
      timestamp: new Date().toISOString(),
      action: 'USER_REPLY',
      admin: userName,
      details: `Replied to message ID: ${messageId}`,
      ip: '127.0.0.1'
    });
    if (data.logs.length > 1000) data.logs = data.logs.slice(0, 1000);

    await updateBinData(data);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// User starts a new conversation
app.post('/api/user/send-message', async (req, res) => {
  try {
    const { userEmail, userName, subject, message } = req.body;
    if (!userEmail || !subject || !message) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    const data = await getBinData();
    const msgs = data.messages;

    const newMsg = {
      id: Date.now(),
      userIds: [userEmail],
      subject,
      message,
      sender: userName || 'User',
      messageType: 'chat',
      timestamp: new Date().toISOString(),
      readBy: [],
      replies: []
    };

    msgs.unshift(newMsg);

    // Log
    data.logs.unshift({
      id: Date.now(),
      timestamp: new Date().toISOString(),
      action: 'USER_SENT_MESSAGE',
      admin: userName || userEmail,
      details: `New message from ${userName || userEmail}: ${subject}`,
      ip: '127.0.0.1'
    });
    if (data.logs.length > 1000) data.logs = data.logs.slice(0, 1000);

    await updateBinData(data);
    res.json({ success: true, messageId: newMsg.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// --------- ADMIN ENDPOINTS ----------

// Login
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (username === ADMIN_USER && password === ADMIN_PASS) {
      const data = await getBinData();
      data.logs.unshift({
        id: Date.now(),
        timestamp: new Date().toISOString(),
        action: 'ADMIN_LOGIN',
        admin: username,
        details: 'Admin logged in successfully',
        ip: '127.0.0.1'
      });
      if (data.logs.length > 1000) data.logs = data.logs.slice(0, 1000);
      await updateBinData(data);
      res.json({ success: true, token: 'admin-token-2025', admin: username });
    } else {
      // Also log failed attempt
      const data = await getBinData();
      data.logs.unshift({
        id: Date.now(),
        timestamp: new Date().toISOString(),
        action: 'ADMIN_LOGIN_FAILED',
        admin: username || 'unknown',
        details: 'Failed login attempt',
        ip: '127.0.0.1'
      });
      await updateBinData(data);
      res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Auth middleware for admin routes
function adminAuth(req, res, next) {
  const authToken = req.headers.authorization;
  if (authToken !== 'Bearer admin-token-2025') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Get all applications
app.get('/api/admin/applications', adminAuth, async (req, res) => {
  try {
    const data = await getBinData();
    // Remove the heavy base64 field for listing (optional)
    const apps = data.forms.map(({ receiptBase64, ...rest }) => rest);
    res.json(apps);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get stats
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const data = await getBinData();
    const forms = data.forms;
    const stats = {
      total: forms.length,
      pending: forms.filter(f => f.status === 'pending_payment').length,
      approved: forms.filter(f => f.status === 'approved').length,
      processing: forms.filter(f => f.status === 'processing').length,
      completed: forms.filter(f => f.status === 'completed').length,
      revenue: forms.filter(f => f.status === 'approved' || f.status === 'processing' || f.status === 'completed').length * 35500,
      recentApplications: forms.slice(0, 10).map(({ receiptBase64, ...rest }) => rest)
    };
    res.json(stats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update application status
app.post('/api/admin/update-status', adminAuth, async (req, res) => {
  try {
    const { id, status, adminName } = req.body;
    const data = await getBinData();
    const forms = data.forms;
    const userIndex = forms.findIndex(f => f.id === parseInt(id));

    if (userIndex === -1) {
      return res.status(404).json({ error: 'User not found' });
    }

    const oldStatus = forms[userIndex].status;
    forms[userIndex].status = status;
    data.forms = forms;

    data.logs.unshift({
      id: Date.now(),
      timestamp: new Date().toISOString(),
      action: 'STATUS_UPDATED',
      admin: adminName || 'admin',
      details: `User ${forms[userIndex].fullName}: ${oldStatus} → ${status}`,
      ip: '127.0.0.1'
    });
    if (data.logs.length > 1000) data.logs = data.logs.slice(0, 1000);

    await updateBinData(data);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add note to user
app.post('/api/admin/add-note', adminAuth, async (req, res) => {
  try {
    const { id, note, adminName } = req.body;
    const data = await getBinData();
    const forms = data.forms;
    const userIndex = forms.findIndex(f => f.id === parseInt(id));

    if (userIndex === -1) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!forms[userIndex].notes) forms[userIndex].notes = [];
    forms[userIndex].notes.push({
      id: Date.now(),
      note,
      admin: adminName || 'admin',
      timestamp: new Date().toISOString()
    });

    data.logs.unshift({
      id: Date.now(),
      timestamp: new Date().toISOString(),
      action: 'NOTE_ADDED',
      admin: adminName || 'admin',
      details: `Added note to user ${forms[userIndex].fullName}`,
      ip: '127.0.0.1'
    });
    if (data.logs.length > 1000) data.logs = data.logs.slice(0, 1000);

    await updateBinData(data);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin send message
app.post('/api/admin/send-message', adminAuth, async (req, res) => {
  try {
    const { userIds, subject, message, sender, messageType } = req.body;
    const data = await getBinData();
    const msgs = data.messages;

    const newMsg = {
      id: Date.now(),
      userIds,
      subject,
      message,
      sender: sender || 'Admin',
      messageType: messageType || 'announcement',
      timestamp: new Date().toISOString(),
      readBy: [],
      replies: []
    };

    msgs.unshift(newMsg);

    data.logs.unshift({
      id: Date.now(),
      timestamp: new Date().toISOString(),
      action: 'MESSAGE_SENT',
      admin: sender || 'admin',
      details: `Sent "${subject}" to ${userIds.length} user(s)`,
      ip: '127.0.0.1'
    });
    if (data.logs.length > 1000) data.logs = data.logs.slice(0, 1000);

    await updateBinData(data);
    res.json({ success: true, messageId: newMsg.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all messages (admin)
app.get('/api/admin/messages', adminAuth, async (req, res) => {
  try {
    const data = await getBinData();
    res.json(data.messages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get logs
app.get('/api/admin/logs', adminAuth, async (req, res) => {
  try {
    const data = await getBinData();
    res.json(data.logs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete user
app.delete('/api/admin/delete-user', adminAuth, async (req, res) => {
  try {
    const { id, adminName } = req.body;
    const data = await getBinData();
    const forms = data.forms;
    const user = forms.find(f => f.id === parseInt(id));

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    data.forms = forms.filter(f => f.id !== parseInt(id));

    data.logs.unshift({
      id: Date.now(),
      timestamp: new Date().toISOString(),
      action: 'USER_DELETED',
      admin: adminName || 'admin',
      details: `Deleted user ${user.fullName} (${user.email})`,
      ip: '127.0.0.1'
    });
    if (data.logs.length > 1000) data.logs = data.logs.slice(0, 1000);

    await updateBinData(data);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Export data
app.get('/api/admin/export', adminAuth, async (req, res) => {
  try {
    const data = await getBinData();
    const exportData = {
      ...data,
      exportDate: new Date().toISOString()
    };
    res.json(exportData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// --------- START SERVER ----------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Favour Visa Server running on jsonbin.io`);
  console.log(`📍 Main Site: http://localhost:${PORT}`);
  console.log(`📍 Admin Panel: http://localhost:${PORT}/admin`);
  console.log(`📍 Admin Login: admin / favourvisa2025`);
});
