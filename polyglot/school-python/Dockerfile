# Build context: polyglot/ (needs grading-cpp + school-python)
FROM debian:bookworm-slim AS grader
RUN apt-get update && apt-get install -y --no-install-recommends g++ cmake ninja-build && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY grading-cpp/CMakeLists.txt ./
COPY grading-cpp/include ./include
COPY grading-cpp/src ./src
COPY grading-cpp/tests ./tests
COPY grading-cpp/third_party ./third_party
RUN cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build --target solob-grade

FROM python:3.13-slim-bookworm AS deps
COPY school-python/requirements.txt /tmp/requirements.txt
RUN python -m venv /venv && /venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt

FROM python:3.13-slim-bookworm
RUN useradd -r -u 10001 app && mkdir -p /data/storage && chown app /data/storage
COPY --from=deps /venv /venv
COPY --from=grader /src/build/solob-grade /usr/local/bin/solob-grade
WORKDIR /app
COPY school-python/solob_school ./solob_school
USER 10001
ENV PATH=/venv/bin:$PATH GRADER_BIN=/usr/local/bin/solob-grade LOCAL_STORAGE_DIR=/data/storage PYTHONDONTWRITEBYTECODE=1
EXPOSE 8101
CMD ["uvicorn","solob_school.app:app","--host","0.0.0.0","--port","8101"]
