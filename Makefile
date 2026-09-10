# Build toolchain: use the MSYS2 mingw64 gcc (matches the mariadb dev package
# installed there). Plain MinGW's gcc cannot compile this because it has no
# MySQL/MariaDB headers.
CC := C:/msys64/mingw64/bin/gcc

# MariaDB Connector/C from MSYS2: headers live in include/mysql, import lib in lib.
MYSQL_INCLUDE := C:/msys64/mingw64/include/mysql
MYSQL_LIBDIR  := C:/msys64/mingw64/lib

# gcc's cc1.exe needs DLLs from mingw64/bin, so that dir MUST be on PATH
# for compilation to work (it dies silently otherwise).
export PATH := C:/msys64/mingw64/bin;$(PATH)

CFLAGS  = -Wall -Wextra -g -I. -I"$(MYSQL_INCLUDE)"
LDFLAGS = -L"$(MYSQL_LIBDIR)" -lmysqlclient

TARGET = shuttle
OBJDIR = build
SRCS = src/main.c \
       src/cli/io.c src/cli/student.c src/cli/guard.c src/cli/scheduler.c \
       src/core/service.c \
       src/db/database.c
OBJS = $(patsubst %.c,$(OBJDIR)/%.o,$(SRCS))

all: $(TARGET)

$(TARGET): $(OBJS)
	$(CC) $(OBJS) -o $(TARGET).exe $(LDFLAGS)

$(OBJDIR)/%.o: %.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -c $< -o $@

# Header dependencies
$(OBJDIR)/src/main.o: src/db/database.h src/core/models.h src/cli/io.h src/cli/student.h src/cli/guard.h src/cli/scheduler.h
$(OBJDIR)/src/cli/io.o: src/cli/io.h
$(OBJDIR)/src/cli/student.o: src/cli/student.h src/cli/io.h src/db/database.h src/core/models.h src/core/service.h
$(OBJDIR)/src/cli/guard.o: src/cli/guard.h src/cli/io.h src/db/database.h src/core/models.h src/core/service.h
$(OBJDIR)/src/cli/scheduler.o: src/cli/scheduler.h src/cli/io.h src/db/database.h src/core/models.h src/core/service.h
$(OBJDIR)/src/core/service.o: src/core/service.h src/core/models.h src/db/database.h
$(OBJDIR)/src/db/database.o: src/db/database.h src/core/models.h

clean:
	rm -rf $(OBJDIR) $(TARGET).exe

.PHONY: all clean
