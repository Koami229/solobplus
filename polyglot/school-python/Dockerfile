# Build context: polyglot/ (needs grading-cpp + school-python)
# Base images pinned by digest (resolved 2026-10-31); bump deliberately, e.g. via Dependabot docker updates.
FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3 AS grader
RUN apt-get update && apt-get install -y --no-install-recommends g++ cmake ninja-build && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY grading-cpp/CMakeLists.txt ./
COPY grading-cpp/include ./include
COPY grading-cpp/src ./src
COPY grading-cpp/tests ./tests
COPY grading-cpp/third_party ./third_party
RUN cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build --target solob-grade

FROM python:3.13-slim-bookworm@sha256:281d39ff02e3b389401586134ff9e6572954687822a58055ec07a60ded4e0b7f AS deps
COPY school-python/requirements.txt /tmp/requirements.txt
RUN python -m venv /venv && /venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt

FROM python:3.13-slim-bookworm@sha256:281d39ff02e3b389401586134ff9e6572954687822a58055ec07a60ded4e0b7f
RUN useradd -r -u 10001 app && mkdir -p /data/storage && chown app /data/storage
COPY --from=deps /venv /venv
COPY --from=grader /src/build/solob-grade /usr/local/bin/solob-grade
WORKDIR /app
COPY school-python/solob_school ./solob_school
USER 10001
ENV PATH=/venv/bin:$PATH GRADER_BIN=/usr/local/bin/solob-grade LOCAL_STORAGE_DIR=/data/storage PYTHONDONTWRITEBYTECODE=1
EXPOSE 8101
CMD ["uvicorn","solob_school.app:app","--host","0.0.0.0","--port","8101"]
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 CMD ["python","-c","import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8101/health', timeout=3).status == 200 else 1)"]
