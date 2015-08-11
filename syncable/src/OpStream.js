"use strict";
var Op = require('./Op');
var util         = require("util");
var EventEmitter = require("events").EventEmitter;

// buffered
// accept/respond to the given stream
// emits 'op' event
// FIXME move reconnection/keepalives to Router
function OpStream (source_stream, source_id, options) {
    EventEmitter.call(this);
    this.options = options = options || {};
    this.pending_s = [];
    this.closed = false;
    this.uri = this.options.uri;
    this.source_id = source_id || 'unknown';
    this.id = this.source_id; // FIXME
    this.stream = source_stream;
    this.remainder = '';
    this.bound_flush = this.flush.bind(this);
    this.lastSendTime = 0;
    //this.serializer = options.serializer || LineBasedSerializer;
    if (options.keepAlive) {
        this.timer = setInterval(this.onTimer.bind(this), 1000);
    }
    this.stream.on('data', this.onStreamDataReceived.bind(this));
    this.stream.on('close', this.onStreamClosed.bind(this));
    this.stream.on('error', this.onStreamError.bind(this));
    options.maxSendFreq;
    options.burstWaitTime;
    OpStream.debug && console.log(this.source_id, "OpStream open");
}
util.inherits(OpStream, EventEmitter);
module.exports = OpStream;
OpStream.debug = false;

OpStream.prototype.deliver = function (op) {
    this.pending_s.push(op);
    if (this.asyncFlush) {
        if (!this.flush_timeout) {
            var delay;
            this.flush_timeout = setTimeout(this.bound_flush, delay);
        }
    } else {
        this.flush();
    }
};
OpStream.prototype.write = OpStream.prototype.send = OpStream.prototype.deliver;

OpStream.prototype.flush = function () {
    if (this.closed) {return;}
    var parcel = this.pending_s.join('');
    this.pending_s = [];
    try {
        OpStream.debug && console.log(this.source_id, '<', parcel);
        this.stream.write(parcel);
        this.lastSendTime = new Date().getTime();
    } catch(ioex) {
        console.error(ioex.message, ioex.stack);
        this.close();
    }
};

OpStream.prototype.onStreamDataReceived = function (data) {
    if (this.closed) { throw new Error('the OpStream is closed'); }
    if (!data) {return;} // keep-alive

    this.remainder += data.toString();

    OpStream.debug && console.log (this.source_id, '>', data);

    var parsed;

    try {
        parsed = Op.parse(this.remainder, this.source_id);
    } catch (ex) {
        console.error(ex.message, ex.stack);
        this.emit('error', 'bad op format');
        this.close(); // crude DDoS protection TODO
        return;
    }

    this.remainder = parsed.remainder;

    var ops = parsed.ops;
    var author = this.options.restrictAuthor || undefined;
    for(var i=0; i<ops.length; i++) {
        var op = ops[i];
        try {
            if (op.spec.isEmpty()) {
                throw new Error('malformed spec: '+snippet(op));
            }
            if (!/\/?#!*\./.test(op.spec.pattern())) {
                throw new Error('invalid spec pattern: '+op.spec);
            }
            if (author!==undefined && op.spec.author()!==author) {
                throw new Error('access violation: '+op.spec);
            }
            this.emit("op", op);
        } catch (ex) {
            console.error('error processing '+op.spec, ex.message, ex.stack);
            this.close();
            break;
        }
    }
};

OpStream.prototype.onStreamClosed = function () {
    if (!this.closed) {
        this.close();
    }
};

OpStream.prototype.onStreamError = function (err) {
    OpStream.debug && console.error('stream error', this.source_id, err);
    this.emit('error', err);
    if (!this.closed) {
        this.close();
    }
};

OpStream.prototype.onTimer = function () {
    //if (!this.id && !this.closed) { FIXME move upstream (Router)
    //    this.close();
    //}    // health check
    // keepalive prevents the conn from being killed by overly smart middleboxes
    // and helps the server to keep track of who's really online
    if (this.options.keepAlive) {
        var time = new Date().getTime();
        var silentTime = time - this.lastSendTime;
        if (silentTime > (this.options.keepAliveInterval||50000)) {
            this.flush();
        }
    }
};

OpStream.prototype.close = function () {
    if (this.closed) {return;}
    this.closed = true;
    this.emit('close');
    this.flush();
    OpStream.debug && console.log(this.source_id, "OpStream closed");
    clearInterval(this.timer);
    try{
        this.stream.end();
    } catch (ex) {
        console.warn('it does not want to close', ex.message, ex.stack);
    }
    var host = this.host;
    var opts = this.options;
    if (opts.reconnect) {
        opts._delay = opts._delay || opts.reconnectDelay || 500;
        opts._delay <<= (opts.reconnectBackoff||2);
        console.log('reconnect scheduled in', opts._delay, 'ms');
        setTimeout(function (){
            console.log('reconnect');
            host.connect(opts.uri, opts);
        }, opts._delay);
    }
};


function snippet (o) {
    return (o||'<empty>').toString().replace(/\n/g,'\\n').substr(0,50);
}
