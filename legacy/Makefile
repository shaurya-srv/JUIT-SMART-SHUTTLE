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
LDFLAGS = -L"$(MYSQL_LIBDIR)" -lmysqlclient -lbcrypt

TARGET = shuttle
OBJDIR = build
SRCS = src/main.c \
       src/cli/io.c src/cli/student.c src/cli/guard.c src/cli/scheduler.c \
       src/core/service.c src/core/crypto.c \
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
$(OBJDIR)/src/core/crypto.o: src/core/crypto.h
$(OBJDIR)/src/db/database.o: src/db/database.h src/core/models.h src/core/crypto.h

clean:
	rm -rf $(OBJDIR) $(TARGET).exe $(API_TARGET).exe

# ------------------------------------------------------------
# HTTP/JSON API server (winsock2, reuses core/ + db/)
# ------------------------------------------------------------
API_TARGET = shuttle_api
API_SRCS = src/api/server.c src/api/handlers.c src/api/json.c \
           src/core/service.c src/core/crypto.c \
           src/db/database.c
API_OBJS = $(patsubst %.c,$(OBJDIR)/%.o,$(API_SRCS))

api: $(API_TARGET)
$(API_TARGET): $(API_OBJS)
	$(CC) $(API_OBJS) -o $(API_TARGET).exe $(LDFLAGS) -lws2_32 -lbcrypt

$(OBJDIR)/src/api/server.o: src/api/server.c src/api/handlers.h src/db/database.h
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -c $< -o $@

$(OBJDIR)/src/api/handlers.o: src/api/handlers.c src/api/handlers.h src/api/json.h src/db/database.h src/core/models.h src/core/service.h src/core/crypto.h
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -c $< -o $@

$(OBJDIR)/src/api/json.o: src/api/json.c src/api/json.h
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -c $< -o $@

.PHONY: all clean test api

# ------------------------------------------------------------
# Unit tests: core assignment algorithm against an in-memory db stub.
# No MySQL server or library needed.
# ------------------------------------------------------------
TESTBIN = $(OBJDIR)/test_service.exe

test: $(TESTBIN)
	./$(TESTBIN)

$(TESTBIN): tests/test_service.c tests/stub_db.c tests/stub_db.h \
            src/core/service.c src/core/service.h src/core/models.h
	@mkdir -p $(OBJDIR)
	$(CC) $(CFLAGS) -Itests $^ -o $@

# ------------------------------------------------------------
# Crypto unit tests (PBKDF2 hashing, CSPRNG) — offline, no db.
# ------------------------------------------------------------
CRYPTOTESTBIN = $(OBJDIR)/test_crypto.exe

test-crypto: $(CRYPTOTESTBIN)
	./$(CRYPTOTESTBIN)

$(CRYPTOTESTBIN): tests/test_crypto.c src/core/crypto.c src/core/crypto.h
	@mkdir -p $(OBJDIR)
	$(CC) $(CFLAGS) $^ -o $@ -lbcrypt

.PHONY: all clean test test-crypto
