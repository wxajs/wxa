import path from 'path';
import {writeFile, getDistPath, readFile, copy} from '../utils';
import debugPKG from 'debug';
import DependencyResolver from '../helpers/dependencyResolver';
import ProgressBar from '../helpers/progressTextBar';
import logger from '../helpers/logger';
import types from '../const/types';

let debug = debugPKG('WXA:Generator');

export default class Generator {
    constructor(cwd, meta, configs, cmdOptions) {
        this.cwd = cwd;
        this.resolve = configs.resolve;
        this.meta = meta;
        this.wxaConfigs = configs;
        this.cmdOptions = cmdOptions;

        this.progress = new ProgressBar(cwd, configs);
    }

    do(mdl) {
        if (mdl.isAbstract) return;

        const text = path.relative(this.cwd, mdl.src);
        this.progress.draw(text, 'Generating', !this.cmdOptions.verbose);

        debug('module to generate %O', mdl);
        // let outputPath;
        // if (!mdl.meta || !mdl.meta.outputPath) {
        //     let dr = new DependencyResolver(this.resolve, this.meta);
        //     outputPath = dr.getOutputPath(mdl.src, mdl.pret, mdl);
        // } else {
        //     outputPath = mdl.meta.outputPath;
        // }
        if (!mdl.output) {
            logger.errors('module 数据结构有问题', mdl);
            return;
        }
        // 重写输出模块
        mdl.output.forEach((outputPath)=>{
            outputPath = this.tryTransFormExtension(outputPath, mdl.kind);
            debug('transform ext %s', outputPath);
            mdl.meta.accOutputPath = outputPath;
            // https://github.com/wxajs/wxa/issues/5#issuecomment-498186337
            // if a module is unrecognized, then we just copy it to dist.
            if (mdl.code != null) {
                let outputCode = mdl.codes && mdl.codes.get(outputPath) || mdl.code;
                if (mdl.sourceMap && mdl.kind === 'js') {
                    writeFile(outputPath+'.map', JSON.stringify(mdl.sourceMap));
                    outputCode += `\n//@ sourceMappingURL=${path.basename(outputPath)}.map`;
                }
                writeFile(outputPath, outputCode);
            } else {
                copy(mdl.src, outputPath);
            }
        });
    }

    tryTransFormExtension(output, kind) {
        if ( ~types.WECHAT.concat(types.TT).indexOf(this.wxaConfigs.target) ) {
            // 小程序相关
            let opath = path.parse(output);

            let ext;
            switch (kind || opath.ext) {
                case '.css':
                case 'css':
                    ext = '.wxss'; break;
                case '.xml':
                case 'xml':
                    ext = '.wxml'; break;
                case '.ts':
                case 'ts':
                case 'typescript':
                    ext = '.js'; break;
                default: ext = opath.ext;
            }

            return opath.dir + path.sep + opath.name + ext;
        }
    }
}
