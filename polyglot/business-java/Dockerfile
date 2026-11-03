# Build context: polyglot/business-java
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src
COPY pom.xml ./
RUN mvn -q -B dependency:go-offline
COPY src ./src
RUN mvn -q -B -DskipTests package dependency:copy-dependencies -DincludeScope=runtime -DoutputDirectory=target/lib

FROM eclipse-temurin:21-jre-alpine
RUN addgroup -S app && adduser -S -G app -u 10001 app && mkdir -p /data/storage && chown app:app /data/storage
WORKDIR /app
COPY --from=build /src/target/*.jar /app/app.jar
COPY --from=build /src/target/lib /app/lib
USER 10001
ENV BIND_HOST=0.0.0.0 PORT=8102 LOCAL_STORAGE_DIR=/data/storage
EXPOSE 8102
ENTRYPOINT ["java","-XX:MaxRAMPercentage=75","-cp","/app/app.jar:/app/lib/*","plus.solob.business.BusinessServer"]
