// shuttle_api — HTTP/JSON server exposing core/ + db/ to the web frontend.
// Winsock2 listener on 127.0.0.1:8080, one thread per connection.
// Each thread acquires its own MySQL connection from the pool — no global lock.

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "handlers.h"
#include "src/db/database.h"

#define LISTEN_PORT 8080
#define RECV_SIZE   8192
#define RESP_HDR_MAX 512
#define POOL_SIZE   4      // concurrent connections; tune for expected load

// ------------------------------------------------------------
// Structured request logging
// ------------------------------------------------------------

static void log_request(const char *method, const char *path, int status, DWORD elapsed_ms) {
    SYSTEMTIME st;
    GetLocalTime(&st);
    // Colour-code by status class.
    const char *clr =
        (status >= 200 && status < 300) ? "\033[32m" :   // green
        (status >= 400 && status < 500) ? "\033[33m" :   // yellow
        (status >= 500)                 ? "\033[31m" :   // red
                                          "\033[0m";
    fprintf(stderr,
        "\033[0m[%04d-%02d-%02d %02d:%02d:%02d.%03d] "
        "%s%-4s %s\033[0m \033[1m%d\033[0m %lums\n",
        st.wYear, st.wMonth, st.wDay,
        st.wHour, st.wMinute, st.wSecond, st.wMilliseconds,
        clr, method, path, status, (unsigned long)elapsed_ms);
}

// Global shutdown flag (set by Ctrl+C handler).
static volatile int g_running = 1;

static BOOL WINAPI ctrl_handler(DWORD type) {
    if (type == CTRL_C_EVENT || type == CTRL_CLOSE_EVENT) {
        printf("\n[INFO] Shutting down...\n");
        g_running = 0;
        return TRUE;
    }
    return FALSE;
}

// ------------------------------------------------------------

static DWORD WINAPI connection_thread(LPVOID arg) {
    SOCKET client = (SOCKET)(intptr_t)arg;

    // Each thread gets its own MySQL connection from the pool.
    db_pool_acquire();

    char req[RECV_SIZE];
    int total = 0;
    for (;;) {
        int n = recv(client, req + total, (int)(sizeof(req) - 1 - total), 0);
        if (n <= 0) break;
        total += n;
        req[total] = '\0';
        if (strstr(req, "\r\n\r\n")) break;
        if (total >= (int)sizeof(req) - 1) break;
    }
    req[total] = '\0';

    // --- Parse request line ---
    char method[8] = "", target[512] = "";
    const char *headers = "";
    {
        char *line_end = strstr(req, "\r\n");
        if (line_end) {
            *line_end = '\0';
            headers = line_end + 2;
            sscanf(req, "%7s %511s", method, target);
        }
    }

    // --- CORS preflight ---
    if (strcmp(method, "OPTIONS") == 0) {
        const char *preflight =
            "HTTP/1.1 204 No Content\r\n"
            "Access-Control-Allow-Origin: *\r\n"
            "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
            "Access-Control-Allow-Headers: Content-Type, Authorization\r\n"
            "Connection: close\r\n"
            "\r\n";
        send(client, preflight, (int)strlen(preflight), 0);
        db_pool_release();
        closesocket(client);
        return 0;
    }

    // Split path / query, and extract the Authorization header value.
    char path[512] = "", query[512] = "", auth[512] = "";
    {
        char *q = strchr(target, '?');
        if (q) { *q = '\0'; snprintf(query, sizeof(query), "%s", q + 1); }
        snprintf(path, sizeof(path), "%s", target);
    }
    {
        const char *a = strstr(headers, "Authorization:");
        if (a) {
            a += strlen("Authorization:");
            while (*a == ' ' || *a == '\t') a++;
            const char *eol = strstr(a, "\r\n");
            size_t len = eol ? (size_t)(eol - a) : strlen(a);
            if (len >= sizeof(auth)) len = sizeof(auth) - 1;
            memcpy(auth, a, len);
            auth[len] = '\0';
        }
    }

    // --- Body: honor Content-Length ---
    const char *body = "";
    {
        const char *body_start = strstr(headers, "\r\n\r\n");
        if (body_start) {
            body_start += 4;
            long content_length = 0;
            const char *cl = strstr(headers, "Content-Length:");
            if (!cl) cl = strstr(headers, "content-length:");
            if (cl) content_length = strtol(cl + strlen("Content-Length:"), NULL, 10);
            if (content_length < 0) content_length = 0;
            size_t have = total - (size_t)(body_start - req);
            while ((long)have < content_length && total < (int)sizeof(req) - 1) {
                int n = recv(client, req + total, (int)(sizeof(req) - 1 - total), 0);
                if (n <= 0) break;
                total += n;
                req[total] = '\0';
                have += (size_t)n;
            }
            body = body_start;
        }
    }

    // --- Dispatch (thread has its own connection — no lock needed) ---
    DWORD t_start = GetTickCount64();
    static char res_body[16384];
    int status;
    status = api_handle_request(method, path, query, auth, body, res_body, sizeof(res_body));
    DWORD elapsed = GetTickCount64() - t_start;

    const char *status_text =
        status == 200 ? "OK"            :
        status == 201 ? "Created"       :
        status == 400 ? "Bad Request"   :
        status == 401 ? "Unauthorized"  :
        status == 403 ? "Forbidden"     :
        status == 404 ? "Not Found"     :
        status == 405 ? "Method Not Allowed" :
        status == 503 ? "Service Unavailable" : "Internal Server Error";

    char hdr[RESP_HDR_MAX];
    int hlen = snprintf(hdr, sizeof(hdr),
        "HTTP/1.1 %d %s\r\n"
        "Content-Type: application/json\r\n"
        "Content-Length: %d\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
        "Access-Control-Allow-Headers: Content-Type, Authorization\r\n"
        "Connection: close\r\n"
        "\r\n",
        status, status_text, (int)strlen(res_body));

    send(client, hdr, hlen, 0);
    send(client, res_body, (int)strlen(res_body), 0);

    // Log the request.
    log_request(method, path, status, elapsed);

    // Return connection to pool, then close socket.
    db_pool_release();
    closesocket(client);
    return 0;
}

// ------------------------------------------------------------

int main(void) {
    const char *mysql_host = getenv("SHUTTLE_DB_HOST"); if (!mysql_host) mysql_host = "127.0.0.1";
    const char *mysql_user = getenv("SHUTTLE_DB_USER"); if (!mysql_user) mysql_user = "root";
    const char *mysql_pass = getenv("SHUTTLE_DB_PASS");
    if (!mysql_pass) {
        fprintf(stderr, "\nError: SHUTTLE_DB_PASS environment variable is not set.\n");
        fprintf(stderr, "  Set it before running:  export SHUTTLE_DB_PASS=yourpassword\n\n");
        WSACleanup();
        return 1;
    }
    const char *mysql_db   = getenv("SHUTTLE_DB_NAME"); if (!mysql_db)   mysql_db = "shuttle_db";
    const char *port_str   = getenv("SHUTTLE_DB_PORT");
    unsigned int mysql_port = port_str ? (unsigned int)atoi(port_str) : 3306;

    printf("\nshuttle_api — JUIT Smart Shuttle HTTP server\n");

    if (!db_init(mysql_host, mysql_user, mysql_pass, mysql_db, mysql_port)) {
        fprintf(stderr, "Failed to connect to MySQL. Exiting.\n");
        return 1;
    }

    // Initialize the connection pool (creates additional connections).
    db_pool_init(POOL_SIZE);
    printf("[INFO] Connection pool: %d connections\n", POOL_SIZE);

    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        fprintf(stderr, "WSAStartup failed.\n");
        db_pool_shutdown();
        db_close();
        return 1;
    }

    api_handlers_init();

    // Graceful shutdown on Ctrl+C.
    SetConsoleCtrlHandler(ctrl_handler, TRUE);

    SOCKET listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (listener == INVALID_SOCKET) {
        fprintf(stderr, "socket() failed: %d\n", WSAGetLastError());
        return 1;
    }

    BOOL reuse = TRUE;
    setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, (const char *)&reuse, sizeof(reuse));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family      = AF_INET;
    addr.sin_port        = htons(LISTEN_PORT);
    addr.sin_addr.s_addr = inet_addr("127.0.0.1");

    if (bind(listener, (struct sockaddr *)&addr, sizeof(addr)) == SOCKET_ERROR) {
        fprintf(stderr, "bind() failed on 127.0.0.1:%d (error %d)\n", LISTEN_PORT, WSAGetLastError());
        closesocket(listener);
        WSACleanup();
        db_pool_shutdown();
        db_close();
        return 1;
    }
    if (listen(listener, SOMAXCONN) == SOCKET_ERROR) {
        fprintf(stderr, "listen() failed: %d\n", WSAGetLastError());
        closesocket(listener);
        WSACleanup();
        db_pool_shutdown();
        db_close();
        return 1;
    }

    printf("Listening on http://127.0.0.1:%d  (Ctrl+C to stop)\n", LISTEN_PORT);
    printf("  Pool size: %d concurrent connections\n", POOL_SIZE);
    printf("  GET|POST  /api/health\n");
    printf("  POST      /api/login\n");
    printf("  POST      /api/requests                (student)\n");
    printf("  GET       /api/requests[?status=...]    (guard/scheduler)\n");
    printf("  GET       /api/requests/mine            (student)\n");
    printf("  POST      /api/requests/{id}/approve|reject (guard)\n");
    printf("  GET|POST  /api/buses                    (scheduler)\n");
    printf("  POST      /api/buses/assign             (scheduler)\n");
    printf("  POST      /api/assignments/unassign     (scheduler)\n");
    printf("  GET       /api/reports/capacity         (scheduler/guard)\n\n");

    while (g_running) {
        SOCKET client = accept(listener, NULL, NULL);
        if (client == INVALID_SOCKET) continue;
        HANDLE t = CreateThread(NULL, 0, connection_thread,
                                (LPVOID)(intptr_t)client, 0, NULL);
        if (t) CloseHandle(t);
        else closesocket(client);
    }

    // Graceful cleanup.
    closesocket(listener);
    api_handlers_shutdown();
    db_pool_shutdown();
    db_close();
    WSACleanup();
    printf("[INFO] Server stopped.\n");
    return 0;
}
