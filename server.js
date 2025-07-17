// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Configuración de la base de datos
const db = new sqlite3.Database('./chat.db');

// Crear tablas si no existen
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      nickname TEXT NOT NULL,
      password TEXT NOT NULL
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room TEXT NOT NULL,
      sender_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(sender_id) REFERENCES users(id)
    )
  `);
});

// Servir archivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// Servir la aplicación principal
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Usuarios en línea
let onlineUsers = [];

// Función para obtener un usuario por nombre de usuario
function getUserByUsername(username, callback) {
  db.get('SELECT * FROM users WHERE username = ?', [username], callback);
}

// Función para crear un nuevo usuario
function createUser(nickname, username, password, callback) {
  bcrypt.hash(password, 10, (err, hash) => {
    if (err) return callback(err);
    
    db.run(
      'INSERT INTO users (nickname, username, password) VALUES (?, ?, ?)',
      [nickname, username, hash],
      function(err) {
        if (err) return callback(err);
        callback(null, this.lastID);
      }
    );
  });
}

// Función para guardar un mensaje
function saveMessage(message, callback) {
  db.run(
    'INSERT INTO messages (room, sender_id, text, timestamp) VALUES (?, ?, ?, ?)',
    [message.room, message.senderId, message.text, new Date(message.timestamp)],
    callback
  );
}

// Función para obtener los últimos mensajes de una sala
function getRoomMessages(room, limit = 100, callback) {
  db.all(
    `SELECT m.*, u.nickname as sender 
     FROM messages m
     JOIN users u ON m.sender_id = u.id
     WHERE room = ?
     ORDER BY timestamp ASC
     LIMIT ?`,
    [room, limit],
    callback
  );
}

// Manejar conexiones de Socket.io
io.on('connection', (socket) => {
  console.log('Nuevo usuario conectado:', socket.id);
  
  // Manejar registro de usuario
  socket.on('register', (data, callback) => {
    const { nickname, username, password } = data;
    
    // Validar datos
    if (!nickname || !username || !password) {
      return callback({ success: false, message: 'Todos los campos son obligatorios' });
    }
    
    // Verificar si el usuario ya existe
    getUserByUsername(username, (err, user) => {
      if (err) {
        return callback({ success: false, message: 'Error en el servidor' });
      }
      
      if (user) {
        return callback({ success: false, message: 'El usuario ya existe' });
      }
      
      // Crear nuevo usuario
      createUser(nickname, username, password, (err, userId) => {
        if (err) {
          return callback({ success: false, message: 'Error al crear el usuario' });
        }
        
        const newUser = {
          id: userId,
          nickname,
          username
        };
        
        callback({ success: true, user: newUser });
      });
    });
  });
  
  // Manejar inicio de sesión
  socket.on('login', (data, callback) => {
    const { username, password } = data;
    
    // Validar datos
    if (!username || !password) {
      return callback({ success: false, message: 'Usuario y contraseña son obligatorios' });
    }
    
    // Buscar usuario
    getUserByUsername(username, (err, user) => {
      if (err || !user) {
        return callback({ success: false, message: 'Credenciales inválidas' });
      }
      
      // Verificar contraseña
      bcrypt.compare(password, user.password, (err, result) => {
        if (err || !result) {
          return callback({ success: false, message: 'Credenciales inválidas' });
        }
        
        const userData = {
          id: user.id,
          nickname: user.nickname,
          username: user.username
        };
        
        callback({ success: true, user: userData });
      });
    });
  });
  
  // Unirse a una sala
  socket.on('join', (data) => {
    const { user, room } = data;
    
    // Guardar referencia del usuario
    socket.user = user;
    socket.room = room;
    
    // Agregar usuario a la lista de usuarios en línea
    onlineUsers = onlineUsers.filter(u => u.id !== user.id);
    onlineUsers.push({ ...user, socketId: socket.id, room });
    
    // Unir al usuario a la sala
    socket.join(room);
    
    // Actualizar lista de usuarios en línea
    io.emit('updateUsers', onlineUsers);
    
    // Notificar a la sala
    io.to(room).emit('systemMessage', {
      text: `${user.nickname} se ha unido al chat`,
      sender: 'Sistema',
      timestamp: Date.now(),
      room
    });
    
    // Enviar mensajes históricos
    getRoomMessages(room, 100, (err, messages) => {
      if (!err) {
        socket.emit('initialData', {
          room,
          messages: messages
        });
      }
    });
  });
  
  // Cambiar de sala
  socket.on('changeRoom', (data) => {
    const { user, newRoom } = data;
    
    // Verificar que el usuario está autenticado
    if (!socket.user || socket.user.id !== user.id) {
      socket.emit('authError', 'No autorizado');
      return;
    }
    
    // Salir de la sala anterior
    socket.leave(socket.room);
    
    // Actualizar usuario en línea
    onlineUsers = onlineUsers.map(u => 
      u.id === user.id ? { ...u, room: newRoom } : u
    );
    
    // Unirse a la nueva sala
    socket.join(newRoom);
    socket.room = newRoom;
    
    // Actualizar lista de usuarios en línea
    io.emit('updateUsers', onlineUsers);
    
    // Notificar cambio de sala
    io.to(newRoom).emit('systemMessage', {
      text: `${user.nickname} se ha unido al chat`,
      sender: 'Sistema',
      timestamp: Date.now(),
      room: newRoom
    });
    
    // Enviar mensajes históricos de la nueva sala
    getRoomMessages(newRoom, 100, (err, messages) => {
      if (!err) {
        socket.emit('initialData', {
          room: newRoom,
          messages: messages
        });
      }
    });
  });
  
  // Manejar mensajes
  socket.on('message', (message) => {
    // Verificar que el usuario está autenticado
    if (!socket.user) {
      socket.emit('authError', 'Debes iniciar sesión para enviar mensajes');
      return;
    }
    
    // Validar mensaje
    if (!message.text || !message.room) {
      return;
    }
    
    // Asignar remitente
    message.senderId = socket.user.id;
    message.sender = socket.user.nickname;
    
    // Guardar mensaje en la base de datos
    saveMessage(message, (err) => {
      if (err) {
        console.error('Error al guardar mensaje:', err);
      }
    });
    
    // Enviar mensaje a todos en la sala
    io.to(message.room).emit('message', message);
  });
  
  // Desconexión
  socket.on('disconnect', () => {
    if (socket.user) {
      // Eliminar de usuarios en línea
      onlineUsers = onlineUsers.filter(u => u.socketId !== socket.id);
      
      // Notificar desconexión
      if (socket.room) {
        io.to(socket.room).emit('systemMessage', {
          text: `${socket.user.nickname} ha abandonado el chat`,
          sender: 'Sistema',
          timestamp: Date.now(),
          room: socket.room
        });
      }
      
      // Actualizar lista de usuarios
      io.emit('updateUsers', onlineUsers);
    }
    console.log('Usuario desconectado:', socket.id);
  });
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});