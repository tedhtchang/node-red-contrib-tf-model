import { homedir } from 'os';
import * as path from 'path';
import { mkdirSync, existsSync, writeFile, writeFileSync } from 'fs';
import * as tf from '@tensorflow/tfjs-node';
import fetch from 'node-fetch';
import { parse as parseURL } from 'url';

/**
 * Represent Node-Red's runtime
 */
type NodeRed = {
  nodes: NodeRedNodes;
};

type NodeRedWire = {
  [index: number]: string;
};

type NodeRedWires = {
  [index: number]: NodeRedWire;
};

type CacheEntry = {
  hash: string;
  lastModified: string;
  filename: string;
};

type CacheEntries = {
  [url: string] : CacheEntry;
};

// Where we store all data for tf-model custom node
const CACHE_DIR = path.join(homedir(), '.node-red', 'tf-model');
// Make sure the CACHE_DIR exists
mkdirSync(CACHE_DIR, {recursive: true});

// A JSON file to store all the cached models
const MODEL_CACHE_ENTRIES = path.join(CACHE_DIR, 'models.json');
// Load cached model entries
const gModelCache: CacheEntries = existsSync(MODEL_CACHE_ENTRIES) ?
    require(MODEL_CACHE_ENTRIES) : {};

if (Object.getOwnPropertyNames(gModelCache).length === 0) {
  updateCacheEntries(MODEL_CACHE_ENTRIES);
}
/**
 * Represent Node-Red's configuration for a custom node
 * For this case, it's the configuration for tf-model node
 */
type NodeRedProperties = {
  id: string;
  type: string;
  name: string;
  modelURL: string;
  wires: NodeRedWires;
};

/**
 * Represent Node-Red's nodes
 */
type NodeRedNodes = {
  // tslint:disable-next-line:no-any
  createNode(node: any, props: NodeRedProperties): void;
  // tslint:disable-next-line:no-any
  registerType(type: string, ctor: any): void;
};

/**
 * Represent Node-Red's message that passes to a node
 */
type NodeRedReceivedMessage = {
  payload: tf.NamedTensorMap;
};

type NodeRedSendMessage = {
  payload: tf.Tensor | tf.Tensor[];
};

type StatusOption = {
  fill: 'red' | 'green' | 'yellow' | 'blue' | 'grey';
  shape: 'ring' | 'dot';
  text: string;
};

type ModelJSON = {
  weightsManifest: [ { paths: string[]}];
};

/**
 * Update cache entry file with current caching
 */
function updateCacheEntries(filename: string) {
  writeFileSync(
      filename,
      JSON.stringify(gModelCache, null, 2),
  );
}

/**
 * Calculate string's hash code
 * @param str string to calculate its hash code
 */
function hashCode(str: string): string {
  let hash = 0, i, chr;
  if (str === undefined || str.length === 0) {
    return `${hash}`;
  }
  for (i = 0; i < str.length; i++) {
    chr   = str.charCodeAt(i);
    hash  = ((hash << 5) - hash) + chr | 0;
  }
  return `${hash}`;
}

/**
 * Fetch a single file from the target url and store it into the specified path.
 * And return the file path.
 * @param url target url
 * @param filePath where to store the fetched file
 */
function fetchAndStore(url: string, filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    fetch(url).then(res => res.buffer())
        .then((buff) => {
          writeFile(filePath, buff, (err) => {
            if (err) {
              reject(err);
            } else {
              resolve(filePath);
            }
          });
        });
  });
}

/**
 * Fetch model files, including model.json and shard files to the specified
 * directory. Also add a cache entry into caching
 * @param url model.json file
 * @param modelFolder store model files in this directory
 */
function fetchNewModelFiles(url: string) {
  let filename: string;
  let modelFile: string;
  const hash = hashCode(url);
  const modelFolder = path.join(CACHE_DIR, hash);
  return fetch(url)
    .then((res) => {
      // all model file will be stored as model.json for now
      // TODO: need to support saved model as well
      const contentType = res.headers.get('content-type');
      if (contentType.indexOf('application/json') !== -1) {
        filename = 'model.json';
      }
      gModelCache[url] = {
        hash,
        lastModified: res.headers.get('last-modified'),
        filename
      };
      updateCacheEntries(MODEL_CACHE_ENTRIES);
      return res.buffer();
    })
    // store the model.json and retrieve shared file list
    .then((body) => {
      return new Promise((resolve, reject) => {
        mkdirSync(modelFolder, { recursive: true });
        modelFile = path.join(modelFolder, filename);
        writeFile(modelFile, body, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve(require(modelFile));
          }
        });
      });
    })
    // store all shared files
    .then((model: ModelJSON) => {
      if (model.weightsManifest !== undefined) {
        const parsedURL = parseURL(url);
        const dirname = path.dirname(parsedURL.pathname);
        const allFetch: Array<Promise<string>> = [];
        model.weightsManifest[0].paths.forEach((shardFile) => {
          parsedURL.pathname = `${dirname}/${shardFile}`;
          allFetch.push(
              fetchAndStore(
                  `${parsedURL.protocol}//${parsedURL.host}${parsedURL.pathname}`,
                  path.join(modelFolder, shardFile)));
        });
        return Promise.all(allFetch);
      }
      return Promise.resolve([]);
    })
    .then(() => modelFile);
}

function downloadOrUpdateModelFiles(url: string): Promise<string> {
  const cacheEntry = gModelCache[url];

  if (cacheEntry !== undefined) {
    return fetch(url, {
          headers: { 'If-Modified-Since': cacheEntry.lastModified },
          method: 'HEAD',
        })
        .then((res) => {
          if(res.status === 304) {
            return path.join(CACHE_DIR, cacheEntry.hash, cacheEntry.filename);
          } else {
            // fetch updated model files
            return fetchNewModelFiles(url);
          }
        });
  } else {
    // let's fetch the model
    return fetchNewModelFiles(url);
  }
}
// Module for a Node-Red custom node
export = function tfModel(RED: NodeRed) {

  class TFModel {
    // tslint:disable-next-line:no-any
    on: (event: string, fn: (msg: any) => void) => void;
    send: (msg: NodeRedSendMessage) => void;
    status: (option: StatusOption) => void;
    log: (msg: string) => void;

    id: string;
    type: string;
    name: string;
    wires: NodeRedWires;
    modelURL: string;
    model: tf.GraphModel;

    constructor(config: NodeRedProperties) {
      this.id = config.id;
      this.type = config.type;
      this.name = config.name;
      this.wires = config.wires;
      this.modelURL = config.modelURL;

      RED.nodes.createNode(this, config);
      this.on('input', (msg: NodeRedReceivedMessage) => {
        this.handleRequest(msg.payload);
      });

      this.on('close', (done: () => void) => {
        this.handleClose(done);
      });

      if (this.modelURL.trim().length > 0) {
        downloadOrUpdateModelFiles(this.modelURL).then((modelPath) => {
            this.status({fill:'red' ,shape:'ring', text:'loading model...'});
            this.log(`loading model from: ${this.modelURL}`);
            tf.loadGraphModel(tf.io.fileSystem(modelPath))
                .then((model: tf.GraphModel) => {
                  this.model = model;
                  this.status({
                    fill:'green',
                    shape:'dot',
                    text:'model is ready'
                  });
                  this.log(`model loaded`);
            });
        });
      }
    }

    // handle a single request
    handleRequest(inputs: tf.NamedTensorMap) {
      this.model.executeAsync(inputs).then((result) => {
        // Clean up the NamedTensorMap here
        for(const one in inputs) {
          inputs[one].dispose();
        }
        this.send({payload: result});
      });
    }

    handleClose(done: () => void) {
      // node level clean up
      if (this.model) {
        this.model.dispose();
      }
      done();
    }

  }

  RED.nodes.registerType('tf-model', TFModel);
};
