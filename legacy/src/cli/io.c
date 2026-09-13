#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <conio.h>
#include "io.h"

void read_password(char *buffer, int size) {
    int i = 0;
    int ch;
    while (1) {
        ch = getch();
        if (ch == '\r' || ch == '\n') {
            break;
        } else if (ch == 8) {
            if (i > 0) {
                i--;
                printf("\b \b");
            }
        } else if (ch == 27) {
            buffer[0] = '\0';
            printf("\n");
            return;
        } else if (i < size - 1) {
            buffer[i++] = (char)ch;
            printf("*");
        }
    }
    buffer[i] = '\0';
    printf("\n");
}

void read_line(char *buffer, int size) {
    if (fgets(buffer, size, stdin) != NULL) {
        buffer[strcspn(buffer, "\n")] = '\0';
    } else {
        buffer[0] = '\0';
    }
}

int read_int(void) {
    char line[64];
    read_line(line, sizeof(line));
    return atoi(line);
}
