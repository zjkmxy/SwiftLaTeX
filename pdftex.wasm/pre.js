const TEXCACHEROOT = "/tex";
const WORKROOT = "/work";
var Module = {};
self.memlog = "";
self.initmem = undefined;
self.mainfile = "main.tex";
self.texlive_endpoint = "https://texlive2.swiftlatex.com/";

const _sendLogMessage = (level, text) =>
  self.postMessage({
    result: "info",
    cmd: "log",
    level: level,
    log: text,
  });

Module["print"] = function (a) {
  self.memlog += a + "\n";
};

Module["printErr"] = function (a) {
  self.memlog += a + "\n";
  _sendLogMessage("log", a);
};

Module["preRun"] = function () {
  FS.mkdir(TEXCACHEROOT);
  FS.mkdir(WORKROOT);
};

function _allocate(content) {
  let res = _malloc(content.length);
  HEAPU8.set(new Uint8Array(content), res);
  return res;
}

function dumpHeapMemory() {
  var src = wasmMemory.buffer;
  var dst = new Uint8Array(src.byteLength);
  dst.set(new Uint8Array(src));
  // _sendLogMessage("log", "Dumping " + src.byteLength);
  return dst;
}

function restoreHeapMemory() {
  if (self.initmem) {
    var dst = new Uint8Array(wasmMemory.buffer);
    dst.set(self.initmem);
  }
}

function closeFSStreams() {
  for (var i = 0; i < FS.streams.length; i++) {
    var stream = FS.streams[i];
    if (!stream || stream.fd <= 2) {
      continue;
    }
    FS.close(stream);
  }
}

function prepareExecutionContext() {
  self.memlog = "";
  restoreHeapMemory();
  closeFSStreams();
  FS.chdir(WORKROOT);
}

Module["postRun"] = function () {
  self.postMessage({
    result: "ok",
  });
  self.initmem = dumpHeapMemory();
};

function cleanDir(dir) {
  let l = FS.readdir(dir);
  for (let i in l) {
    let item = l[i];
    if (item === "." || item === "..") {
      continue;
    }
    item = dir + "/" + item;
    let fsStat = undefined;
    try {
      fsStat = FS.stat(item);
    } catch (err) {
      _sendLogMessage("error", "Not able to fsstat " + item);
      continue;
    }
    if (FS.isDir(fsStat.mode)) {
      cleanDir(item);
    } else {
      try {
        FS.unlink(item);
      } catch (err) {
        _sendLogMessage("error", "Not able to unlink " + item);
      }
    }
  }

  if (dir !== WORKROOT) {
    try {
      FS.rmdir(dir);
    } catch (err) {
      _sendLogMessage("error", "Not able to top level " + dir);
    }
  }
}

Module["onAbort"] = function () {
  self.memlog += "Engine crashed";
  self.postMessage({
    result: "failed",
    status: -254,
    log: self.memlog,
    cmd: "compile",
  });
  return;
};

function compileLaTeXRoutine() {
  prepareExecutionContext();
  const setMainFunction = cwrap("setMainEntry", "number", ["string"]);
  setMainFunction(self.mainfile);
  let status = _compileLaTeX();
  if (status === 0) {
    let pdfArrayBuffer = null;
    _compileBibtex();
    try {
      let pdfurl =
        WORKROOT +
        "/" +
        self.mainfile.substr(0, self.mainfile.length - 4) +
        ".pdf";
      pdfArrayBuffer = FS.readFile(pdfurl, {
        encoding: "binary",
      });
    } catch (err) {
      _sendLogMessage("error", "Fetch content failed.");
      status = -253;
      self.postMessage({
        result: "failed",
        status: status,
        log: self.memlog,
        cmd: "compile",
      });
      return;
    }
    self.postMessage(
      {
        result: "ok",
        status: status,
        log: self.memlog,
        pdf: pdfArrayBuffer.buffer,
        cmd: "compile",
      },
      [pdfArrayBuffer.buffer]
    );
  } else {
    _sendLogMessage("error", "Compilation failed, with status code " + status);
    self.postMessage({
      result: "failed",
      status: status,
      log: self.memlog,
      cmd: "compile",
    });
  }
}

function compileFormatRoutine() {
  prepareExecutionContext();
  let status = _compileFormat();
  if (status === 0) {
    let pdfArrayBuffer = null;
    try {
      let pdfurl = WORKROOT + "/pdflatex.fmt";
      pdfArrayBuffer = FS.readFile(pdfurl, {
        encoding: "binary",
      });
    } catch (err) {
      _sendLogMessage("error", "Fetch content failed.");
      status = -253;
      self.postMessage({
        result: "failed",
        status: status,
        log: self.memlog,
        cmd: "compile",
      });
      return;
    }
    self.postMessage(
      {
        result: "ok",
        status: status,
        log: self.memlog,
        pdf: pdfArrayBuffer.buffer,
        cmd: "compile",
      },
      [pdfArrayBuffer.buffer]
    );
  } else {
    _sendLogMessage(
      "error",
      "Compilation format failed, with status code " + status
    );
    self.postMessage({
      result: "failed",
      status: status,
      log: self.memlog,
      cmd: "compile",
    });
  }
}

function mkdirRoutine(dirname) {
  try {
    //_sendLogMessage("log", "removing " + item);
    FS.mkdir(WORKROOT + "/" + dirname);
    self.postMessage({
      result: "ok",
      cmd: "mkdir",
    });
  } catch (err) {
    _sendLogMessage("error", "Not able to mkdir " + dirname);
    self.postMessage({
      result: "failed",
      cmd: "mkdir",
    });
  }
}

function writeFileRoutine(filename, content) {
  try {
    FS.writeFile(WORKROOT + "/" + filename, content);
    self.postMessage({
      result: "ok",
      cmd: "writefile",
    });
  } catch (err) {
    _sendLogMessage("error", "Unable to write mem file");
    self.postMessage({
      result: "failed",
      cmd: "writefile",
    });
  }
}

function setTexliveEndpoint(url) {
  if (url) {
    if (!url.endsWith("/")) {
      url += "/";
    }
    self.texlive_endpoint = url;
  }
}

self["onmessage"] = function (ev) {
  let data = ev["data"];
  let cmd = data["cmd"];
  if (cmd === "compilelatex") {
    compileLaTeXRoutine();
  } else if (cmd === "compileformat") {
    compileFormatRoutine();
  } else if (cmd === "settexliveurl") {
    setTexliveEndpoint(data["url"]);
  } else if (cmd === "mkdir") {
    mkdirRoutine(data["url"]);
  } else if (cmd === "writefile") {
    writeFileRoutine(data["url"], data["src"]);
  } else if (cmd === "setmainfile") {
    self.mainfile = data["url"];
  } else if (cmd === "grace") {
    _sendLogMessage("error", "Gracefully Close");
    self.close();
  } else if (cmd === "flushcache") {
    cleanDir(WORKROOT);
  } else {
    _sendLogMessage("error", "Unknown command " + cmd);
  }
};

let texlive404_cache = {};
let texlive200_cache = {};

function kpse_find_file_impl(nameptr, format, _mustexist) {
  const reqname = UTF8ToString(nameptr);

  if (reqname.includes("/")) {
    return 0;
  }

  const cacheKey = format + "/" + reqname;

  if (cacheKey in texlive404_cache) {
    return 0;
  }

  if (cacheKey in texlive200_cache) {
    const savepath = texlive200_cache[cacheKey];
    return _allocate(intArrayFromString(savepath));
  }

  const remote_url = self.texlive_endpoint + "pdftex/" + cacheKey;
  let xhr = new XMLHttpRequest();
  xhr.open("GET", remote_url, false);
  xhr.timeout = 150000;
  xhr.responseType = "arraybuffer";
  _sendLogMessage("log", "Start downloading texlive file " + remote_url);
  try {
    xhr.send();
  } catch (err) {
    _sendLogMessage("log", "TexLive Download Failed " + remote_url);
    return 0;
  }

  if (xhr.status === 200) {
    let arraybuffer = xhr.response;
    const fileid = xhr.getResponseHeader("fileid");
    const savepath = TEXCACHEROOT + "/" + fileid;
    FS.writeFile(savepath, new Uint8Array(arraybuffer));
    texlive200_cache[cacheKey] = savepath;
    return _allocate(intArrayFromString(savepath));
  } else if (xhr.status === 301) {
    _sendLogMessage("log", "TexLive File not exists " + remote_url);
    texlive404_cache[cacheKey] = 1;
    return 0;
  }
  return 0;
}

let pk404_cache = {};
let pk200_cache = {};

function kpse_find_pk_impl(nameptr, dpi) {
  const reqname = UTF8ToString(nameptr);

  if (reqname.includes("/")) {
    return 0;
  }

  const cacheKey = dpi + "/" + reqname;

  if (cacheKey in pk404_cache) {
    return 0;
  }

  if (cacheKey in pk200_cache) {
    const savepath = pk200_cache[cacheKey];
    return _allocate(intArrayFromString(savepath));
  }

  const remote_url = self.texlive_endpoint + "pdftex/pk/" + cacheKey;
  let xhr = new XMLHttpRequest();
  xhr.open("GET", remote_url, false);
  xhr.timeout = 150000;
  xhr.responseType = "arraybuffer";
  _sendLogMessage("log", "Start downloading texlive file " + remote_url);
  try {
    xhr.send();
  } catch (err) {
    _sendLogMessage("log", "TexLive Download Failed " + remote_url);
    return 0;
  }

  if (xhr.status === 200) {
    let arraybuffer = xhr.response;
    const pkid = xhr.getResponseHeader("pkid");
    const savepath = TEXCACHEROOT + "/" + pkid;
    FS.writeFile(savepath, new Uint8Array(arraybuffer));
    pk200_cache[cacheKey] = savepath;
    return _allocate(intArrayFromString(savepath));
  } else if (xhr.status === 301) {
    _sendLogMessage("log", "TexLive File not exists " + remote_url);
    pk404_cache[cacheKey] = 1;
    return 0;
  }
  return 0;
}
