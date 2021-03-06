
/**
 * SOCKS5 client module I wrote because all the other
 * ones did not work.
 *
 * @author Kristopher Ives <kristopher.ives@gmail.com>
 * 
 */

var net = require('net');
var EventEmitter = require('events').EventEmitter;
var ByteOrder = require('network-byte-order');
var inherits = require('util').inherits;

// Error messages for when the proxy responds to sendConnect() used in handleConnect()
var connectErrors = {
	// Messages are taken from Wikipedia
    0x00: 'request granted',
    0x01: 'general failure',
    0x02: 'connection not allowed by ruleset',
    0x03: 'network unreachable',
    0x04: 'host unreachable',
    0x05: 'connection refused by destination host',
    0x06: 'TTL expired',
    0x07: 'command not supported / protocol error',
    0x08: 'address type not supported'
};

// Construct for module object
function ProxySocket(socksHost, socksPort, socket) {
	var self = this;
	var connecting = false;
	var connected = false;
	var stage = 0;
	var host = '', port = 0;
	
	// While the socket is still being setup the encoding
	// is saved as we expect binray encoding on the socket
	// until then
	var socketEncoding = 'utf8';
	
	// Default host/ports to use if not given
	socksHost = socksHost || 'localhost';
	socksPort = socksPort || '9050';
	
	// Users can pass their own socket if they already have one
	// connected to the SOCKS proxy
	socket = socket || (new net.Socket());
	
	// A socket emits events like 'data' and 'connect'
	EventEmitter.call(self);
	
	// Read event for the real socket
	socket.on('data', function (buffer) {
		// Emit an event useful for debugging the raw SOCKS data
		self.emit('socksdata', buffer);
		
		if (connected) {
			// Pass data though already connected socket
			self.emit('data', buffer);
		} else {
			if (typeof buffer === 'string') {
				buffer = new Buffer(buffer, 'binary');
			}
			
			// Handle SOCKS protocol data
			handleData(buffer);
		}
	});
	
	socket.on('error', function () {
		self.emit('error');
	});
	
	socket.on('end', function () {
		self.emit('end');
	});
	
	socket.on('timeout', function () {
		self.emit('timeout');
	});
	
	socket.on('close', function () {
		if (connected) {
			self.emit('close');
		}
	});
	
	socket.on('drain', function () {
		if (connected) {
			self.emit('drain');
		}
	});
	
	socket.on('readable', function () {
		if (connected) {
			self.emit('readable');
		}
	});
	
	self.read = function (size) {
		if (!connected) {
			return null;
		}
		
		return socket.read(size);
	};
	
	self.destroy = function () {
		return socket.destroy();
	};
	
	var connectionStages = [
		handleAuth,
		handleConnect
	];
	
	// Handle SOCKS protocol specific data
	function handleData(buffer) {
		while (buffer && stage < connectionStages.length) {
			buffer = connectionStages[stage](buffer);
			stage++;
		}
		
		// Emit the sockets first packet
		if (connected && buffer) {
			self.emit('data', buffer);
		}
	}
	
	// Handle the response after sending authentication
	function handleAuth(d) {
		var error;
		
		if (d.length !== 2) {
			error = new Error('SOCKS authentication failed. Unexpected number of bytes received.');
		} else if (d[0] !== 0x05) {
			error = new Error('SOCKS authentication failed. Unexpected SOCKS version number: ' + d[0] + '.');
		} else if (d[1] !== 0x00) {
			error = new Error('SOCKS authentication failed. Unexpected SOCKS authentication method: ' + d[1] + '.');
		}
		
		if (error) {
			self.emit('error', error);
			return;
		}
		
		sendConnect();
	}
	
	// Handle the response after sending connection request
	function handleConnect(d) {
		var error;
		
		if (d[0] !== 0x05) {
			error = new Error('SOCKS connection failed. Unexpected SOCKS version number: ' + d[0] + '.');
		} else if (d[1] !== 0x00) {
			error = new Error('SOCKS connection failed. ' + connectErrors[d[1]] + '.');
		} else if (d[2] !== 0x00) {
			error = new Error('SOCKS connection failed. The reserved byte must be 0x00.');
		}
		
		if (error) {
			self.emit('error', error);
			return;
		}
		
		connected = true;
		self.readable = true;
		self.writable = true;
		
		// TODO map some of the addresses?
		//self.remotePort = port;
		//self.remoteAddress = address;
		self.bufferSize = socket.bufferSize;
		
		// Set the real encoding which could have been
		// changed while the socket was connecting
		socket.setEncoding(socketEncoding);
		
		// Emit the real 'connect' event
		self.emit('connect');
	}
	
	function sendAuth() {
		var request = new Buffer(3);
		request[0] = 0x05;  // SOCKS version
		request[1] = 0x01;  // number of authentication methods
		request[2] = 0x00;  // no authentication
		
		if (!socket.write(request)) {
			throw new Error("Unable to write to SOCKS socket");
		}
	}
	
	function parseDomainName(host, buffer) {
		var i, c;
	
		buffer.push(host.length);
		for (i = 0; i < host.length; i++) {
			c = host.charCodeAt(i);
			buffer.push(c);
		}
	}
	
	function sendConnect() {
		var buffer = [
			0x05, // SOCKS version
			0x01, // Command code: establish a TCP/IP stream connection
			0x00  // Reserved - myst be 0x00
		];
		
		switch (net.isIP(host)) {
			default:
			case 0:
				buffer.push(0x03);
				parseDomainName(host, buffer);
				break;
			case 4:
				buffer.push(0x01);
				parseIPv4(host, buffer);
				break;
			//case 6:
			//	buffer.push(0x04);
			//	if (parseIPv6(host, buffer) === false) {
			//		self.emit('error', new Error('IPv6 host parsing failed. Invalid address.'));
			//		return;
			//	}
			//	
			//	break;
		}
		
		ByteOrder.htons(buffer, buffer.length, port);
		request = new Buffer(buffer);
		
		if (!socket.write(request)) {
			throw new Error("Unable to write to SOCKS socket");
		}
	}
	
	self.setTimeout = function (timeout, f) {
		return socket.setTimeout(timeout, f);
	};
	
	self.connect = function (connectHost, connectPort, f) {
		if (connected) {
			throw new Error("Socket is already connected");
		}
		
		if (connecting) {
			throw new Error("Socket is already connecting");
		}
		
		host = connectHost;
		port = connectPort;
		connected = false;
		connecting = true;
		
		if (f) {
			self.on('connect', f);
		}
		
		socket.setEncoding('binary');
		
		socket.connect(socksPort, socksHost, function () {
			connecting = false;
			sendAuth();
		});
	};
	
	self.write = function (data, encoding, f) {
		if (!connected) {
			throw new Error("Socket is not connected");
		}
		
		return socket.write(data, encoding, f);
	};
	
	self.pause = function () {
		socket.pause();
	};
	
	self.resume = function () {
		socket.resume();
	};
	
	self.address = function () {
		return socket.address();
	};
	
	self.end = function (data, encoding) {
		if (!connected) {
			return socket.end();
		}
		
		return socket.end(data, encoding);
	};
	
	self.setEncoding = function (encoding) {
		if (connected) {
			socket.setEncoding(encoding);
		} else {
			// Save encoding to be set once connected
			socketEncoding = encoding;
		}
	};
	
	return self;
}

inherits(ProxySocket, EventEmitter);

module.exports = ProxySocket;
