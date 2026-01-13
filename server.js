const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 4000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin123';
const DB_PATH = path.join(__dirname, 'data.sqlite');

const db = new sqlite3.Database(DB_PATH);

const dbRun = (sql, params = []) =>
    new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
const dbGet = (sql, params = []) =>
    new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
const dbAll = (sql, params = []) =>
    new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });

db.serialize(() => {
    db.run(`
    CREATE TABLE IF NOT EXISTS books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      year INTEGER NOT NULL,
      category TEXT NOT NULL,
      price REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'available', -- available | unavailable | sold
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

    db.run(`
    CREATE TABLE IF NOT EXISTS rentals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      user_name TEXT NOT NULL,
      mode TEXT NOT NULL, -- purchase | rent
      duration_days INTEGER,
      start_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME,
      status TEXT NOT NULL DEFAULT 'active', -- active | completed | expired
      reminded INTEGER DEFAULT 0,
      FOREIGN KEY (book_id) REFERENCES books (id)
    )
  `);
});

async function seed() {
    const count = await dbGet(`SELECT COUNT(*) as c FROM books`);
    if (count && count.c === 0) {
        const favorites = [
            ['Мастер и Маргарита', 'Михаил Булгаков', 1966, 'Роман', 500, 'available'],
            ['Три товарища', 'Эрих Мария Ремарк', 1936, 'Роман', 450, 'available'],
            ['Солярис', 'Станислав Лем', 1961, 'Фантастика', 400, 'available'],
            ['Над пропастью во ржи', 'Джером Д. Сэлинджер', 1951, 'Классика', 350, 'available'],
            ['Гарри Поттер и Философский камень', 'Дж. К. Роулинг', 1997, 'Фэнтези', 300, 'available']
        ];
        for (const [title, author, year, category, price, status] of favorites) {
            await dbRun(
                `INSERT INTO books (title, author, year, category, price, status) VALUES (?, ?, ?, ?, ?, ?)`,
                [title, author, year, category, price, status]
            );
        }
        console.log('Seeded favorite books');
    }
}
seed().catch(console.error);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function adminRequired(req, res, next) {
    const key = req.headers['x-admin-key'];
    if (!key || key !== ADMIN_KEY) {
        return res.status(401).json({ error: 'Admin key required' });
    }
    return next();
}

// Helpers
function buildBookFilter(query) {
    const conditions = [];
    const params = [];
    if (query.category) {
        conditions.push('LOWER(category) LIKE ?');
        params.push(`%${String(query.category).toLowerCase()}%`);
    }
    if (query.author) {
        conditions.push('LOWER(author) LIKE ?');
        params.push(`%${String(query.author).toLowerCase()}%`);
    }
    if (query.year) {
        conditions.push('year = ?');
        params.push(Number(query.year));
    }
    if (query.status) {
        conditions.push('status = ?');
        params.push(query.status);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    let sortClause = 'ORDER BY created_at DESC';
    if (query.sort === 'author') sortClause = 'ORDER BY author ASC';
    if (query.sort === 'category') sortClause = 'ORDER BY category ASC';
    if (query.sort === 'year') sortClause = 'ORDER BY year DESC';

    return { where, params, sortClause };
}

// Public routes
app.get('/api/books', async (req, res) => {
    try {
        let books = await dbAll(`SELECT * FROM books`);
        const categoryQ = (req.query.category || '').trim().toLowerCase();
        const authorQ = (req.query.author || '').trim().toLowerCase();
        const yearQ = req.query.year ? Number(req.query.year) : null;
        const statusQ = req.query.status || '';

        if (categoryQ) {
            books = books.filter((b) => b.category && b.category.toLowerCase().includes(categoryQ));
        }
        if (authorQ) {
            books = books.filter((b) => b.author && b.author.toLowerCase().includes(authorQ));
        }
        if (yearQ) {
            books = books.filter((b) => Number(b.year) === yearQ);
        }
        if (statusQ) {
            books = books.filter((b) => b.status === statusQ);
        }

        const sort = req.query.sort;
        if (sort === 'author') {
            books.sort((a, b) => String(a.author).localeCompare(String(b.author), 'ru'));
        } else if (sort === 'category') {
            books.sort((a, b) => String(a.category).localeCompare(String(b.category), 'ru'));
        } else if (sort === 'year') {
            books.sort((a, b) => Number(b.year) - Number(a.year));
        } else {
            books.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        }

        res.json(books);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal error' });
    }
});

app.get('/api/books/:id', async (req, res) => {
    try {
        const book = await dbGet(`SELECT * FROM books WHERE id = ?`, [req.params.id]);
        if (!book) return res.status(404).json({ error: 'Книга не найдена' });
        res.json(book);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal error' });
    }
});

function computeDurationDays(duration) {
    if (duration === '2w') return 14;
    if (duration === '1m') return 30;
    if (duration === '3m') return 90;
    return null;
}

app.post('/api/rent', async (req, res) => {
    try {
        const { bookId, userName, mode, duration } = req.body;
        if (!bookId || !userName || !mode) {
            return res.status(400).json({ error: 'bookId, userName, mode обязательны' });
        }
        const book = await dbGet(`SELECT * FROM books WHERE id = ?`, [bookId]);
        if (!book) return res.status(404).json({ error: 'Книга не найдена' });
        if (book.status === 'sold') return res.status(400).json({ error: 'Книга продана' });
        const now = new Date();
        if (mode === 'purchase') {
            await dbRun(
                `INSERT INTO rentals (book_id, user_name, mode, duration_days, expires_at, status) VALUES (?, ?, ?, ?, ?, ?)`,
                [bookId, userName, 'purchase', null, null, 'completed']
            );
            await dbRun(`UPDATE books SET status = 'sold' WHERE id = ?`, [bookId]);
            return res.json({ message: 'Покупка оформлена' });
        }
        if (mode === 'rent') {
            const days = computeDurationDays(duration);
            if (!days) return res.status(400).json({ error: 'Некорректная длительность' });
            const expires = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
            await dbRun(
                `INSERT INTO rentals (book_id, user_name, mode, duration_days, expires_at) VALUES (?, ?, ?, ?, ?)`,
                [bookId, userName, 'rent', days, expires]
            );
            return res.json({ message: 'Аренда оформлена', expiresAt: expires });
        }
        return res.status(400).json({ error: 'mode должен быть purchase или rent' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal error' });
    }
});

// Admin routes
app.post('/api/admin/books', adminRequired, async (req, res) => {
    try {
        const { title, author, year, category, price, status = 'available' } = req.body;
        if (!title || !author || !year || !category || price === undefined) {
            return res.status(400).json({ error: 'title, author, year, category, price обязательны' });
        }
        await dbRun(
            `INSERT INTO books (title, author, year, category, price, status) VALUES (?, ?, ?, ?, ?, ?)`,
            [title, author, Number(year), category, Number(price), status]
        );
        res.json({ message: 'Книга добавлена' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal error' });
    }
});

app.put('/api/admin/books/:id', adminRequired, async (req, res) => {
    try {
        const { id } = req.params;
        const existing = await dbGet(`SELECT * FROM books WHERE id = ?`, [id]);
        if (!existing) return res.status(404).json({ error: 'Книга не найдена' });
        const {
            title = existing.title,
            author = existing.author,
            year = existing.year,
            category = existing.category,
            price = existing.price,
            status = existing.status
        } = req.body;
        await dbRun(
            `UPDATE books SET title = ?, author = ?, year = ?, category = ?, price = ?, status = ? WHERE id = ?`,
            [title, author, Number(year), category, Number(price), status, id]
        );
        res.json({ message: 'Книга обновлена' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal error' });
    }
});

app.delete('/api/admin/books/:id', adminRequired, async (req, res) => {
    try {
        const { id } = req.params;
        const existing = await dbGet(`SELECT * FROM books WHERE id = ?`, [id]);
        if (!existing) return res.status(404).json({ error: 'Книга не найдена' });
        await dbRun(`DELETE FROM books WHERE id = ?`, [id]);
        await dbRun(`DELETE FROM rentals WHERE book_id = ?`, [id]);
        res.json({ message: 'Книга удалена' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal error' });
    }
});

app.get('/api/admin/rentals', adminRequired, async (_req, res) => {
    try {
        const rentals = await dbAll(
            `SELECT rentals.*, books.title, books.author
       FROM rentals JOIN books ON rentals.book_id = books.id
       ORDER BY rentals.start_at DESC`
        );
        res.json(rentals);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal error' });
    }
});

app.get('/api/admin/reminders', adminRequired, async (_req, res) => {
    try {
        const now = new Date().toISOString();
        const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
        const rentals = await dbAll(
            `SELECT rentals.*, books.title, books.author
       FROM rentals JOIN books ON rentals.book_id = books.id
       WHERE rentals.mode = 'rent' AND rentals.status = 'active'
         AND rentals.expires_at IS NOT NULL
         AND rentals.expires_at BETWEEN ? AND ?
       ORDER BY rentals.expires_at ASC`,
            [now, soon]
        );
        res.json(rentals);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal error' });
    }
});

// Health
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// Reminder job: mark expired and log reminders
async function runReminderJob() {
    try {
        const nowISO = new Date().toISOString();
        // expire
        await dbRun(
            `UPDATE rentals SET status = 'expired' WHERE mode = 'rent' AND status = 'active' AND expires_at IS NOT NULL AND expires_at < ?`,
            [nowISO]
        );
        // find to remind (within 24h and not reminded)
        const soon = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        const toRemind = await dbAll(
            `SELECT rentals.id, rentals.user_name, rentals.expires_at, books.title
       FROM rentals JOIN books ON rentals.book_id = books.id
       WHERE rentals.mode = 'rent' AND rentals.status = 'active'
         AND rentals.expires_at BETWEEN ? AND ? AND rentals.reminded = 0`,
            [nowISO, soon]
        );
        if (toRemind.length) {
            toRemind.forEach((r) => {
                console.log(
                    `[REMINDER] Пользователю ${r.user_name} истекает аренда "${r.title}" в ${r.expires_at}`
                );
            });
            const ids = toRemind.map((r) => r.id);
            const placeholders = ids.map(() => '?').join(',');
            await dbRun(`UPDATE rentals SET reminded = 1 WHERE id IN (${placeholders})`, ids);
        }
    } catch (err) {
        console.error('Reminder job error:', err);
    }
}

setInterval(runReminderJob, 60 * 1000);

app.listen(PORT, () => {
    console.log(`Bookshop server running at http://localhost:${PORT}`);
});

