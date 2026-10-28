FROM mcr.microsoft.com/playwright:v1.56.1-noble
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg git ca-certificates iptables build-essential && rm -rf /var/lib/apt/lists/*
# Native modules (e.g. bcrypt) compile against the bundled Node headers instead
# of downloading them from nodejs.org, which the package proxy does not allow.
ENV npm_config_nodedir=/usr
WORKDIR /opt/work-tools
RUN npm install --omit=dev --ignore-scripts playwright@1.56.1
COPY tools/ /opt/work-tools/
RUN chmod -R a-w /opt/work-tools && mkdir -p /workspace && chown pwuser:pwuser /workspace
USER pwuser
WORKDIR /workspace
