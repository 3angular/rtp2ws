# Asterisk 22 (current LTS) built from source with the AMR-WB codec module
# compiled in (github.com/traud/asterisk-amr) — stock Asterisk has no AMR
# support at all, and the trunk's codec list is AMR-WB + PCMA (spec §6).
FROM debian:trixie-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential autoconf automake libtool pkg-config wget ca-certificates git \
    libedit-dev libjansson-dev libsqlite3-dev uuid-dev libxml2-dev libssl-dev \
    libsrtp2-dev libopencore-amrnb-dev libopencore-amrwb-dev libvo-amrwbenc-dev \
    file patch bzip2 python3 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src
RUN wget -q https://downloads.asterisk.org/pub/telephony/asterisk/asterisk-22-current.tar.gz \
 && tar xzf asterisk-22-current.tar.gz \
 && rm asterisk-22-current.tar.gz \
 && mv asterisk-22* asterisk

# Drop the AMR codec sources into the tree, apply its core patches, and
# regenerate the build system (per the asterisk-amr README).
RUN git clone --depth 1 https://github.com/traud/asterisk-amr.git \
 && cp asterisk-amr/codecs/* asterisk/codecs/ \
 && cp asterisk-amr/res/* asterisk/res/ \
 && cp asterisk-amr/include/asterisk/* asterisk/include/asterisk/ \
 && cd asterisk \
 && patch -p0 < ../asterisk-amr/codec_amr.patch \
 && patch -p0 < ../asterisk-amr/build_tools.patch

WORKDIR /usr/src/asterisk
RUN ./bootstrap.sh \
 && ./configure --with-pjproject-bundled \
 && make menuselect.makeopts \
 && menuselect/menuselect --enable codec_amr --enable res_format_attr_amr menuselect.makeopts \
 && make -j"$(nproc)" \
 && make install DESTDIR=/out \
 # /var/run is a symlink to /run on trixie; a real dir in the copy would clash
 && rm -rf /out/var/run

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    libedit2 libjansson4 libsqlite3-0 libuuid1 libxml2 libssl3 libsrtp2-1 \
    libopencore-amrnb0 libopencore-amrwb0 libvo-amrwbenc0 \
    python3 python3-yaml ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/ /
COPY static/ /etc/asterisk/
COPY render-config.py /render-config.py
RUN ldconfig && mkdir -p /run/asterisk
CMD ["sh", "-c", "python3 /render-config.py /config/rtp2ws.yaml && exec asterisk -f"]
