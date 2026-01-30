# things to do

Websockets do not automatically reconnect on client in some situations.  There may be no reconnect logic at all, or a bug.  Noticed this on Windows.  The impact is that conversations don't load.  Seems to happen when laptop was locked for a while.