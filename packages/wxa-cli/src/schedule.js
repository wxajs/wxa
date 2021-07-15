import crypto from 'crypto';
import {unlinkSync, statSync} from 'fs';
import path from 'path';
import globby from 'globby';
import debugPKG from 'debug';
import {SyncHook} from 'tapable';

import {readFile, isFile, getHash, getHashWithString} from './utils';
import bar from './helpers/progressBar';
import {logger, error} from './helpers/logger';
import COLOR from './const/color';
import ROOT from './const/root';
import defaultPret from './const/defaultPret';
import wrapWxa from './helpers/wrapWxa';
import Compiler from './compilers/index';
import DependencyResolver from './helpers/dependencyResolver';
import ProgressTextBar from './helpers/progressTextBar';
import Preformance from './helpers/performance';
import simplify from './helpers/simplifyObj';
import {treeShake} from './tree-shake/index';

let debug = debugPKG('WXA:Schedule');

class Schedule {
    constructor(loader) {
        this.current = process.cwd();
        this.loader = loader;
        this.pending = [];
        this.waiting = [];
        this.finished = [];
        this.npmOrLocal = [];

        this.meta = {
            current: this.current,
            wxaExt: 'wxa',
            nodeModule: path.join(this.current, 'node_modules'),
            libSrc: path.join(__dirname, '../lib-dist'),
            libs: ['wxa_wrap.js'],
            context: path.join(this.current, 'src'),
        };

        this.max = 5;

        this.bar = bar;
        this.logger = logger;
        this.mode = 'compile';
        this.wxaConfigs = {}; // wxa.config.js

        let wxaConfigs;
        Object.defineProperty(this, 'wxaConfigs', {
            get() {
                return wxaConfigs;
            },
            set(configs) {
                wxaConfigs = configs;

                this.APP_CONFIG_PATH = wxaConfigs.resolve.appConfigPath;
                this.APP_SCRIPT_PATH = wxaConfigs.resolve.appScriptPath;

                this.meta = {
                    ...this.meta,
                    wxaExt: wxaConfigs.resolve.wxaExt,
                    context: wxaConfigs.context,
                    output: wxaConfigs.output,
                };
            },
        });

        this.$pageArray = new Map(); // denpendencies
        this.$depPending = []; // pending dependencies
        // this.$indexOfModule = [ROOT];
        this.$indexOfModule = new Map([['__root__', ROOT]]); // all module
        // if is mounting compiler, all task will be blocked.
        this.$isMountingCompiler = false;
        this.progress = new ProgressTextBar(this.current, wxaConfigs);
        this.$depJsPending = [];

        // save all app configurations for compile time.
        // such as global components.
        this.app = {};

        // load from path/to/project/src/app.json
        this.appConfigs = {};

        // cmd options
        this.cmdOptions = {};

        // performance mark
        this.perf = new Preformance();

        // hooks
        this.hooks = {
            buildModule: new SyncHook(['module']),
            succeedModule: new SyncHook(['module']),
            failedModule: new SyncHook(['module', 'error']),
        };
    }

    set(name, value) {
        this[name] = value;
    }

    addEntryPoint(mdl) {
        let child = this.findOrAddDependency(mdl, ROOT);

        if (!ROOT.childNodes.has(mdl.src)) ROOT.childNodes.set(child.src, child);

        return child;
    }

    async doDPA() {
        if (!this.$depPending.length) {
            logger.error('找不到可编译的入口文件');
            throw new Error('找不到可编译的入口文件');
        }

        debug('depPending %o', this.$depPending);
        debug('DPA started');

        return this.$doDPA();
    }

    async $doDPA() {
        let tasks = [];
    
        while (this.$depPending.length) {
            let dep = this.$depPending.shift();

            if (!this.cmdOptions.watch && dep.src.endsWith('.js')) {
                this.$depJsPending.push(dep);
            } else {
                tasks.push(this.$parse(dep));
            }

            // debug('file to parse %O', dep);
        }

        let succ = await Promise.all(tasks);

        if (this.$depPending.length === 0) {
            // dependencies resolve complete
            if (!this.cmdOptions.watch) {
                let sub = await this.$dojsDPA();
                return succ.concat(sub);
            }

            this.progress.clean();
            return succ;
        } else {
            let sub = await this.$doDPA();
            return succ.concat(sub);
        }
    }

    async $dojsDPA() {
        this.$depPending = this.$depJsPending;
        this.$depJsPending = [];
        let entries = this.$depPending.map((item)=>({src: item.src, content: item.content}));
        console.time('shake');
        let contents = treeShake(
            {
                entry: entries,
                resolveSrc: {
                    root: 'src',
                    alias: this.wxaConfigs.resolve.alias,
                },
                commonJS: {
                    enable: true,
                },
            }
        );
        console.timeEnd('shake');

        let run = async () => {
            let tasks = [];

            while (this.$depPending.length) {
                let dep = this.$depPending.shift();
                let content = contents[dep.src] && contents[dep.src].formattedCode;
                if (content) {
                    dep.content = content;
                }
    
                tasks.push(this.$parse(dep));
            }
    
            let succ = await Promise.all(tasks);
    
            if (this.$depPending.length === 0) {
                // dependencies resolve complete
                this.progress.clean();
                return succ;
            } else {
                let sub = await run();
                return succ.concat(sub);
            }
        };

        return run();
    }

    async $parse(dep) {
        if (dep.color === COLOR.COMPILED) return dep;
        if (dep.color === COLOR.CHANGED) dep.code = void(0);
        // calc hash
        // cause not every module is actually exists, we can not promise all module has hash here.
        let content = dep.content ? dep.content : readFile(dep.src);
        dep.content = content;
        if (content) dep.hash = crypto.createHash('md5').update(content).digest('hex');
        debug('Dep HASH: %s', dep.hash);
        try {
            const relativeSrc = path.relative(this.current, dep.src);
            const text = this.cmdOptions.verbose ? `(Hash: ${dep.hash})    ${relativeSrc}` : relativeSrc;

            this.progress.draw(text, 'COMPILING', !this.cmdOptions.verbose);
            this.perf.markStart(relativeSrc);
            this.hooks.buildModule.call(dep);

            // loader: use custom compiler to load resource.
            await this.loader.compile(dep, this);

            this.perf.markEnd(relativeSrc);

            // try to wrap wxa every app and page
            this.tryWrapWXA(dep);
            this.tryAddPolyfill(dep);

            // Todo: conside if cache is necessary here.
            // debug('dep to process %O', dep);
            let compiler = new Compiler(this.wxaConfigs.resolve, this.meta, this.appConfigs, this);
            let childNodes = await compiler.parse(dep);

            compiler.destroy();

            // empty loader handle this module.
            if (dep.code == null && !dep.isFile) dep.code = dep.content;

            debug('childNodes', childNodes.map((node)=>simplify(node)));
            let children = childNodes.reduce((children, node)=>{
                let child = this.findOrAddDependency(node, dep);

                if (child) children.push([child.src, child]);
                return children;
            }, []);

            // if watch mode, use childNodes to clean up the dep tree.
            // update each module's childnodes, then according to reference unlink file.
            this.cleanUpChildren(new Map(children), dep);

            // cover new childNodes
            dep.childNodes = new Map(children);
            dep.color = COLOR.COMPILED;

            // if module is app.json, then add Page entry points.
            if (dep.meta && dep.meta.source === this.APP_CONFIG_PATH) {
                let oldPages = new Map(this.$pageArray.entries());
                let newPages = this.addPageEntryPoint();
                newPages = new Map(newPages.map((page)=>[page.src, page]));
                this.cleanUpPages(newPages, oldPages);
            }

            this.calcFileSize(dep);

            this.hooks.succeedModule.call(dep);

            return dep;
        } catch (e) {
            debug('编译失败 %O', e);
            dep.color = COLOR.COMPILE_ERROR;
            this.hooks.failedModule.call(dep, e);
            error('编译失败', {name: dep.src, error: e});
        }
    }

    cleanUpChildren(newChildren, mdl) {
        debug('clean up module %O', simplify(mdl));
        if (
            mdl.childNodes == null ||
            mdl.childNodes.size === 0
        ) return;

        mdl.childNodes.forEach((oldChild, src)=>{
            if (
                newChildren.has(src) ||
                !oldChild.reference.has(mdl.src)
            ) return;
            // child node not used, update reference.
            debug('denpendencies clean up started');

            oldChild.reference.delete(src);

            if (
                oldChild.reference.size === 0 &&
                !oldChild.isROOT
            ) {
                debug('useless module find %s', oldChild.src);
                // nested clean children
                this.cleanUpChildren(new Map(), oldChild);
                // unlink module
                this.deleteFile(oldChild);
                this.$indexOfModule.delete(src);
            }
        });
    }

    cleanUpPages(newPages, oldPages) {
        let droppedPages = [];
        oldPages.forEach((oldPage)=>{
            if (!newPages.has(oldPage.src)) droppedPages.push(oldPage);
        });

        droppedPages.forEach((droppedPage)=>{
            debug('dropped page %O', droppedPage);
            // nested clean up children module
            this.cleanUpChildren(new Map(), droppedPage);

            // drop module from index
            if (this.$indexOfModule.has(droppedPage.src)) {
                this.$indexOfModule.delete(droppedPage.src);
            }

            this.deleteFile(droppedPage);
        });
    }

    deleteFile(mdl) {
        if (mdl.isAbstract || !mdl.output) return;

        mdl.output.forEach((info, outputPath)=>{
            try {
                if (info.reality) unlinkSync(info.reality);
            } catch (e) {
                logger.error(e);
            }
        });
    }

    findOrAddDependency(dep, mdl) {
        // if a dependency is from remote, or dynamic path, or base64 format, then we ignore it.
        // cause we needn't process this kind of resource.
        if (
            dep.pret.isURI ||
            dep.pret.isDynamic ||
            dep.pret.isBase64 ||
            dep.pret.isPlugin
        ) return null;

        debug('Find Dependencies started %O', simplify(dep));

        // pret backup
        dep.pret = dep.pret || defaultPret;

        // the amount of child output is decided by his parent module.
        // normally one, emit multi while child module is npm package.
        // debugger;
        let child = {
            ...dep,
            color: COLOR.INIT,
            isNodeModule: dep.src.indexOf(this.meta.nodeModule) > -1,
            isWXARuntime: dep.src.indexOf(this.meta.libSrc) > -1,
            isPlugin: dep.pret.isPlugin,
            reference: new Map([[mdl.src, mdl]]),
            output: new Set([dep.meta.outputPath]),
            outerDependencies: new Set(),
            dependency: function(file) {
                // debugger;
                this.outerDependencies.add(path.normalize(file));
            },
        };

        let indexedModule = this.$indexOfModule.get(dep.src);
        if (indexedModule && indexedModule.color === COLOR.INIT) {
            // merge reference, cause the module is parsed
            if (indexedModule.reference instanceof Map) {
                indexedModule.reference.set(mdl.src, mdl);
            } else {
                indexedModule.reference = new Map([[mdl.src, mdl]]);
            }
            return indexedModule;
        } else if (indexedModule) {
            // check hash
            child.hash = !child.isAbstract && child.content ? getHashWithString(child.content) : getHash(child.src);

            // module changed: clean up mdl, mark module as changed.
            if (
                child.hash !== indexedModule.hash
            ) {
                indexedModule.content = child.content;
                indexedModule.hash = child.hash;
                indexedModule.color = COLOR.CHANGED;
            }

            // merge reference, cause the module is parsed
            if (indexedModule.reference instanceof Map) {
                indexedModule.reference.set(mdl.src, mdl);
            } else {
                indexedModule.reference = new Map([[mdl.src, mdl]]);
            }

            // merge output
            // if (!indexedModule.output.has(dep.meta.outputPath)) {
            //     indexedModule.output.set(dep.meta.outputPath, child.get(dep.meta.outputPath));
            // }

            child = indexedModule;
        }

        if (~[COLOR.CHANGED, COLOR.COMPILE_ERROR, COLOR.INIT].indexOf(child.color)) this.$depPending.push(child);
        if (child.color === COLOR.INIT) this.$indexOfModule.set(child.src, child);

        return child;
    }

    tryWrapWXA(mdl) {
        if (
            ~['app', 'component', 'page'].indexOf(mdl.category ? mdl.category.toLowerCase() : '') &&
            mdl.meta && path.extname(mdl.meta.source) === '.js' &&
            (/exports\.default/gm.test(mdl.code) || /exports\[["']default["']/gm.test(mdl.code)) &&
            !/wrapWxa\(exports/gm.test(mdl.code)
        ) {
            mdl.code = wrapWxa(mdl.code, mdl.category, mdl.pagePath);
            debug('wrap dependencies %O', simplify(mdl));
        }
    }

    tryAddPolyfill(mdl) {
        if (!this.wxaConfigs.polyfill) return;

        const polyfill = new Map([
            ['regenerator-runtime/runtime', {
                test(mdl) {
                    // if js file do not have regeneratorRuntime polyfill
                    // or babelRuntime polyfill we add it.
                    return (
                        mdl.meta && path.extname(mdl.meta.source) === '.js' &&
                        /regeneratorRuntime/.test(mdl.code) &&
                        !/var\sregeneratorRuntime \=/.test(mdl.code) &&
                        !/@babel\/runtime\/regenerator/.test(mdl.code)
                    );
                },
                wrap(mdl) {
                    mdl.code = `
                    var regeneratorRuntime = require('wxa://regenerator-runtime/runtime');

                    ${mdl.code}
                    `;
                },
            }],
            ['es.promise.finally', {
                    test(mdl) {
                        return mdl.category && ~['app'].indexOf(mdl.category.toLowerCase()) &&
                        mdl.meta && path.extname(mdl.meta.source) === '.js';
                    },
                    wrap(mdl) {
                        mdl.code = `
                        require('wxa://es/promise.finally.js');

                        ${mdl.code}
                        `;
                    },
                },
            ],
        ]);

        polyfill.forEach((preset, name)=>{
            if (this.wxaConfigs.polyfill[name] && preset.test(mdl)) preset.wrap(mdl);
        });
    }

    addPageEntryPoint() {
        // ToDo: drop entry point and clean up children after page entry point update.
        if (
            this.appConfigs == null ||
            !this.appConfigs.pages ||
            !this.appConfigs.pages.length
        ) {
            logger.error('app页面配置缺失, 请检查app.json的pages配置项');
        }

        let pages = this.appConfigs.pages.slice(0).map((page)=>['', page]);
        // multi packages process.
        // support both subpackages and subPackages
        // see: https://developers.weixin.qq.com/miniprogram/dev/framework/subpackages/basic.html
        let pkg = this.appConfigs.subpackages || this.appConfigs.subPackages;

        if (pkg) {
            // flattern pages array and remember the subpackage's root.
            let subPages = pkg.reduce((prev, pkg)=>{
                if (Array.isArray(pkg.pages)) {
                    pkg.pages.forEach((pagePath)=>{
                        prev.push(
                            [pkg.root, pkg.root.replace(/\/$/, '')+'/'+pagePath]
                        );
                    });
                }

                return prev;
            }, []);
            pages = pages.concat(subPages);
        }

        // tarbar configs
        let tabBarList = (this.appConfigs.tabBar && this.appConfigs.tabBar.list) || [];
        tabBarList.forEach((val) => {
            if (val.iconPath) {
                pages = pages.concat([['', val.iconPath]]);
            }
            if (val.selectedIconPath) {
                pages = pages.concat([['', val.selectedIconPath]]);
            }
        });

        // usingComponents
        if (this.appConfigs.usingComponents) {
            Object.values(this.appConfigs.usingComponents).forEach((val) => {
                pages = pages.concat([['', val]]);
            });
        }

        // pages spread
        let newPages = pages.reduce((ret, [pkg, page])=>{
            // wxa file
            let wxaPage = path.join(this.meta.context, page+this.meta.wxaExt);

            debug('page %s %s', wxaPage, page);
            let dr = new DependencyResolver(this.wxaConfigs.resolve, this.meta);
            
            if (/.+(png|jpg|jpeg|webp|eot|woff|woff2|ttf|file')$/.test(page)) {
                let src = path.join(this.meta.context, page);
                try {
                    return ret.concat([this.addEntryPoint({
                        content: '',
                        src,
                        category: '',
                        pagePath: src,
                        pret: defaultPret,
                        package: pkg,
                        isFile: true,
                        meta: {
                            source: src,
                            outputPath: dr.getOutputPath(src, defaultPret, ROOT),
                        },
                    })]);
                } catch (e) {
                    logger.error(e);
                }
            } else if (isFile(wxaPage)) {
                try {
                    let pagePoint = this.addEntryPoint({
                        content: readFile(wxaPage),
                        src: wxaPage,
                        category: 'Page',
                        pagePath: page,
                        pret: defaultPret,
                        isAbstract: true,
                        package: pkg,
                        meta: {
                            source: wxaPage,
                        },
                    });

                    return ret.concat([pagePoint]);
                } catch (e) {
                    logger.error(e);
                }
            } else {
                let sections = globby.sync(path.join(this.meta.context, page+'.*'));

                sections.forEach((section)=>{
                    if (isFile(section)) {
                        let outputPath = dr.getOutputPath(section, defaultPret, ROOT);
                        let pagePoint = this.addEntryPoint({
                            content: readFile(section),
                            src: section,
                            category: 'Page',
                            pagePath: page,
                            pret: defaultPret,
                            package: pkg,
                            meta: {
                                source: section,
                                outputPath,
                            },
                        });

                        ret.push(pagePoint);
                    }
                });

                return ret;
            }
        }, []);

        newPages.forEach((page)=>this.$pageArray.set(page.src, page));
        return newPages;
    }

    calcFileSize(dep) {
        if (dep.isFile || dep.kind === 'wxa') {
            let stat = statSync(dep.src);

            dep.size = stat['size'];
        } else if (dep.code) {
            dep.size = Buffer.byteLength(dep.code, 'utf8');
        } else {
            dep.size = 0;
        }
    }
}

export default Schedule;
