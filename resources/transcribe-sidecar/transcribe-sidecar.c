// transcribe-sidecar: keeps one transcribe.cpp (ggml) speech model resident
// and answers requests over stdin/stdout, like the sherpa-onnx WS sidecar.
//
// It runs as its own process because Electron's built-in allocator refuses
// the single ~1 GB weight buffer that larger GGUF models (Canary 1B) need.
//
// Usage:
//   transcribe-sidecar --model model.gguf [--langid langid.gguf] [--threads N]
//
// On start it prints one JSON line:
//   {"ready":true,"arch":"...","languages":["de",...],"langid":true}
// or {"ready":false,"error":"..."} and exits 1.
//
// Requests are one text line followed by raw little-endian float32 16 kHz
// mono PCM of <bytes> bytes:
//   T <bytes> <language|->\n<pcm>          transcribe
//   L <bytes> <code,code,...|->\n<pcm>     language ID among the listed codes
// Each request gets exactly one JSON line back:
//   {"ok":true,"text":"...","language":"de","truncated":false,"ms":123}
//   {"ok":true,"code":"de","p":0.98,"ms":12}
//   {"ok":false,"status":13,"error":"..."}
// SIGUSR1 aborts the request in progress (it answers with status 13).
// stdout carries only protocol lines; library logs go to stderr.
// The transcript text is never written anywhere but stdout.

#include "transcribe.h"
#include "transcribe/langid.h"

#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define MAX_HEADER 4096
#define MAX_LANGS 64
// 20 minutes of 16 kHz float32 audio; far beyond any single request.
#define MAX_PCM_BYTES ((size_t) 20 * 60 * 16000 * 4)

static volatile sig_atomic_t g_abort = 0;

static void on_sigusr1(int sig) {
    (void) sig;
    g_abort = 1;
}

static bool abort_cb(void * user_data) {
    (void) user_data;
    return g_abort != 0;
}

static double now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double) ts.tv_sec * 1000.0 + (double) ts.tv_nsec / 1e6;
}

static void json_string(FILE * out, const char * s) {
    fputc('"', out);
    for (const unsigned char * p = (const unsigned char *) (s ? s : ""); *p; ++p) {
        switch (*p) {
            case '"': fputs("\\\"", out); break;
            case '\\': fputs("\\\\", out); break;
            case '\n': fputs("\\n", out); break;
            case '\r': fputs("\\r", out); break;
            case '\t': fputs("\\t", out); break;
            default:
                if (*p < 0x20) {
                    fprintf(out, "\\u%04x", *p);
                } else {
                    fputc(*p, out);
                }
        }
    }
    fputc('"', out);
}

static void reply_error(int status, const char * message) {
    fprintf(stdout, "{\"ok\":false,\"status\":%d,\"error\":", status);
    json_string(stdout, message ? message : transcribe_status_string(status));
    fputs("}\n", stdout);
    fflush(stdout);
}

// Reads exactly n bytes; returns 0 on success, -1 on EOF or error.
static int read_exact(void * buf, size_t n) {
    size_t got = 0;
    while (got < n) {
        size_t r = fread((char *) buf + got, 1, n - got, stdin);
        if (r == 0) return -1;
        got += r;
    }
    return 0;
}

// Discards n bytes so the stream stays framed after a rejected request.
static int skip_bytes(size_t n) {
    char tmp[65536];
    while (n > 0) {
        size_t chunk = n < sizeof(tmp) ? n : sizeof(tmp);
        if (read_exact(tmp, chunk) != 0) return -1;
        n -= chunk;
    }
    return 0;
}

int main(int argc, char ** argv) {
    const char * model_path  = NULL;
    const char * langid_path = NULL;
    int          n_threads   = 0;
    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--model") == 0 && i + 1 < argc) {
            model_path = argv[++i];
        } else if (strcmp(argv[i], "--langid") == 0 && i + 1 < argc) {
            langid_path = argv[++i];
        } else if (strcmp(argv[i], "--threads") == 0 && i + 1 < argc) {
            n_threads = atoi(argv[++i]);
        } else {
            fprintf(stdout, "{\"ready\":false,\"error\":\"bad argument\"}\n");
            return 2;
        }
    }
    if (!model_path) {
        fprintf(stdout, "{\"ready\":false,\"error\":\"--model is required\"}\n");
        return 2;
    }

    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = on_sigusr1;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGUSR1, &sa, NULL);

    // CPU only: no GPU driver code is ever loaded. Backend modules are found
    // next to libtranscribe (package-local default).
    struct transcribe_backend_init_params backend_params;
    transcribe_backend_init_params_init(&backend_params);
    backend_params.allowed_backends = TRANSCRIBE_BACKEND_MASK_CPU;
    transcribe_status st = transcribe_init_backends_ex(&backend_params);
    if (st != TRANSCRIBE_OK) {
        fprintf(stdout, "{\"ready\":false,\"error\":");
        json_string(stdout, transcribe_status_string(st));
        fputs("}\n", stdout);
        return 1;
    }

    struct transcribe_model_load_params load_params;
    transcribe_model_load_params_init(&load_params);
    load_params.backend = TRANSCRIBE_BACKEND_CPU;

    struct transcribe_model * model = NULL;
    st = transcribe_model_load_file(model_path, &load_params, &model);
    if (st != TRANSCRIBE_OK) {
        fprintf(stdout, "{\"ready\":false,\"error\":");
        json_string(stdout, transcribe_status_string(st));
        fputs("}\n", stdout);
        return 1;
    }

    struct transcribe_session_params session_params;
    transcribe_session_params_init(&session_params);
    session_params.n_threads = n_threads;
    struct transcribe_session * session = NULL;
    st = transcribe_session_init(model, &session_params, &session);
    if (st != TRANSCRIBE_OK) {
        fprintf(stdout, "{\"ready\":false,\"error\":");
        json_string(stdout, transcribe_status_string(st));
        fputs("}\n", stdout);
        transcribe_model_free(model);
        return 1;
    }
    transcribe_set_abort_callback(session, abort_cb, NULL);

    struct transcribe_model *          langid_model   = NULL;
    struct transcribe_langid_session * langid_session = NULL;
    if (langid_path) {
        st = transcribe_model_load_file(langid_path, &load_params, &langid_model);
        if (st == TRANSCRIBE_OK) {
            struct transcribe_langid_session_params lp;
            transcribe_langid_session_params_init(&lp);
            lp.n_threads = n_threads;
            st = transcribe_langid_session_init(langid_model, &lp, &langid_session);
        }
        if (st != TRANSCRIBE_OK) {
            fprintf(stdout, "{\"ready\":false,\"error\":");
            json_string(stdout, transcribe_status_string(st));
            fputs("}\n", stdout);
            return 1;
        }
        transcribe_langid_set_abort_callback(langid_session, abort_cb, NULL);
    }

    struct transcribe_capabilities caps;
    transcribe_capabilities_init(&caps);
    transcribe_model_get_capabilities(model, &caps);
    fputs("{\"ready\":true,\"arch\":", stdout);
    json_string(stdout, transcribe_model_arch_string(model));
    fputs(",\"version\":", stdout);
    json_string(stdout, transcribe_version());
    fputs(",\"languages\":[", stdout);
    for (int i = 0; i < caps.n_languages; ++i) {
        if (i) fputc(',', stdout);
        json_string(stdout, caps.languages[i]);
    }
    fprintf(stdout, "],\"supportsLanguageDetect\":%s,\"langid\":%s}\n",
            caps.supports_language_detect ? "true" : "false", langid_session ? "true" : "false");
    fflush(stdout);

    char    header[MAX_HEADER];
    float * pcm     = NULL;
    size_t  pcm_cap = 0;
    while (fgets(header, sizeof(header), stdin)) {
        char   kind     = 0;
        size_t n_bytes  = 0;
        char   arg[MAX_HEADER];
        arg[0] = '\0';
        if (sscanf(header, "%c %zu %4095s", &kind, &n_bytes, arg) < 2) {
            reply_error(TRANSCRIBE_ERR_INVALID_ARG, "malformed request header");
            continue;
        }
        if (n_bytes == 0 || n_bytes % 4 != 0 || n_bytes > MAX_PCM_BYTES) {
            if (skip_bytes(n_bytes) != 0) break;
            reply_error(TRANSCRIBE_ERR_INVALID_ARG, "bad audio size");
            continue;
        }
        if (n_bytes > pcm_cap) {
            float * grown = (float *) realloc(pcm, n_bytes);
            if (!grown) {
                if (skip_bytes(n_bytes) != 0) break;
                reply_error(TRANSCRIBE_ERR_OOM, "out of memory");
                continue;
            }
            pcm     = grown;
            pcm_cap = n_bytes;
        }
        if (read_exact(pcm, n_bytes) != 0) break;
        int n_samples = (int) (n_bytes / 4);
        g_abort       = 0;
        double t0     = now_ms();

        if (kind == 'T') {
            struct transcribe_run_params rp;
            transcribe_run_params_init(&rp);
            if (arg[0] && strcmp(arg, "-") != 0) rp.language = arg;
            st = transcribe_run(session, pcm, n_samples, &rp);
            // A decode that hit its budget or started looping keeps a
            // readable partial transcript; report it as truncated.
            bool truncated = st == TRANSCRIBE_ERR_OUTPUT_TRUNCATED || st == TRANSCRIBE_ERR_OUTPUT_REPETITION;
            if (st != TRANSCRIBE_OK && !truncated) {
                reply_error(st, NULL);
                continue;
            }
            fputs("{\"ok\":true,\"text\":", stdout);
            json_string(stdout, transcribe_full_text(session));
            fputs(",\"language\":", stdout);
            json_string(stdout, transcribe_detected_language(session));
            fprintf(stdout, ",\"truncated\":%s,\"ms\":%.0f}\n", truncated ? "true" : "false", now_ms() - t0);
            fflush(stdout);
        } else if (kind == 'L') {
            if (!langid_session) {
                reply_error(TRANSCRIBE_ERR_UNSUPPORTED_ROLE, "no language-ID model loaded");
                continue;
            }
            const char * allowed[MAX_LANGS];
            int          n_allowed = 0;
            if (arg[0] && strcmp(arg, "-") != 0) {
                for (char * tok = strtok(arg, ","); tok && n_allowed < MAX_LANGS; tok = strtok(NULL, ",")) {
                    allowed[n_allowed++] = tok;
                }
            }
            struct transcribe_langid_params lp;
            transcribe_langid_params_init(&lp);
            lp.allowed   = n_allowed ? allowed : NULL;
            lp.n_allowed = n_allowed;
            st           = transcribe_langid_run(langid_session, pcm, n_samples, &lp);
            if (st != TRANSCRIBE_OK) {
                reply_error(st, NULL);
                continue;
            }
            struct transcribe_langid_candidate best;
            transcribe_langid_candidate_init(&best);
            transcribe_langid_get_candidate(langid_session, 0, &best);
            fputs("{\"ok\":true,\"code\":", stdout);
            json_string(stdout, best.code);
            fprintf(stdout, ",\"p\":%.4f,\"ms\":%.0f}\n", best.p, now_ms() - t0);
            fflush(stdout);
        } else {
            reply_error(TRANSCRIBE_ERR_INVALID_ARG, "unknown request kind");
        }
    }

    free(pcm);
    transcribe_langid_session_free(langid_session);
    transcribe_model_free(langid_model);
    transcribe_session_free(session);
    transcribe_model_free(model);
    return 0;
}
