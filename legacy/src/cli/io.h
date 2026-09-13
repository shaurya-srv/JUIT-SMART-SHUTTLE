#ifndef CLI_IO_H
#define CLI_IO_H

// Shared console input helpers for the CLI clients.

// Read a password with masked input (shows * instead of characters).
// Escape cancels: buffer becomes empty.
void read_password(char *buffer, int size);

// Read one line of text, stripping the trailing newline.
void read_line(char *buffer, int size);

// Read one line and parse it as an integer (0 if not parseable).
int read_int(void);

#endif // CLI_IO_H
