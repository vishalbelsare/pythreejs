var _ = require('underscore');
var widgets = require('@jupyter-widgets/base');
var Promise = require('bluebird');
var ndarray = require('ndarray');
var dataserializers = require('jupyter-dataserializers');

var THREE = require('three');

var Enums = require('./enums');

var utils = require('./utils');

var EXTENSION_SPEC_VERSION = require('../version').EXTENSION_SPEC_VERSION;


/**
 * Helper function for listening to child models in lists/dicts
 *
 * @param {any} model The parent model
 * @param {any} propNames The propetry names that are lists/dicts
 * @param {any} callback The callback to call when child changes
 */
function listenNested(model, propNames, callback) {
    propNames.forEach(function(propName) {
        // listen to current values in array
        var curr = model.get(propName) || [];
        // support properties that are either an instance, or a
        // sequence of instances:
        if (curr instanceof ThreeModel) {
            model.listenTo(curr, 'change', callback);
            model.listenTo(curr, 'childchange', callback);
        } else {
            utils.childModelsNested(curr).forEach(function(childModel) {
                model.listenTo(childModel, 'change', callback);
                model.listenTo(childModel, 'childchange', callback);
            });
        }

        // make sure to (un)hook listeners when array changes
        model.on('change:' + propName, function(model, value) {
            var prev = model.previous(propName) || [];
            var curr = value || [];

            // Check for instance values:
            if (prev instanceof ThreeModel) {
                model.stopListening(prev);
            }
            if (curr instanceof ThreeModel) {
                model.listenTo(curr, 'change', callback);
                model.listenTo(curr, 'childchange', callback);
            }
            // Done if both are instance values:
            if (prev instanceof ThreeModel && curr instanceof ThreeModel) {
                return;
            }
            if (prev instanceof ThreeModel) {
                // Implies curr is array/dict
                utils.childModelsNested(curr).forEach(function(childModel) {
                    model.listenTo(childModel, 'change', callback);
                    model.listenTo(childModel, 'childchange', callback);
                });
            } else if (curr instanceof ThreeModel) {
                // Implies prev is array/dict
                utils.childModelsNested(prev).forEach(function(childModel) {
                    model.stopListening(childModel);
                });
            } else {
                // Both are arrays/dicts
                var diff = utils.nestedDiff(curr, prev);

                diff.added.forEach(function(childModel) {
                    model.listenTo(childModel, 'change', callback);
                    model.listenTo(childModel, 'childchange', callback);
                });
                diff.removed.forEach(function(childModel) {
                    model.stopListening(childModel);
                });
            }
        });
    });
}


class ThreeModel extends widgets.WidgetModel {

    defaults() {
        return _.extend(widgets.WidgetModel.prototype.defaults.call(this), {
            _model_name: this.constructor.model_name,
            _model_module: this.constructor.model_module,
            _model_module_version: this.constructor.model_module_version
        });
    }

    initialize(attributes, options) {
        widgets.WidgetModel.prototype.initialize.apply(this, arguments);

        this.createPropertiesArrays();

        if (options.three_obj) {
            // We are defining the object from a given THREE object!

            // We need to push a default state first, as comm open does
            // not support buffers!
            // Fixed in:
            // - @jupyterlab/services@0.49.0
            // - notebook 5.1.0
            this.save_changes();

            var obj = options.three_obj;
            delete options.three_obj;

            this.processNewObj(obj);

            this.initPromise = this.createUninitializedChildren().bind(this).then(function() {

                // sync in all the properties from the THREE object
                this.syncToModel(true);

                // setup msg, model, and children change listeners
                this.setupListeners();

            });
            return;
        }

        // Instantiate Three.js object
        this.initPromise = this.createThreeObjectAsync().bind(this).then(function() {
            return this.createUninitializedChildren();
        }).then(function() {

            // pull in props created by three
            this.syncToModel();

            // sync the rest from the server to the model
            this.syncToThreeObj(true);

            // setup msg, model, and children change listeners
            this.setupListeners();

        });

    }

    createPropertiesArrays() {
        // initialize properties arrays
        this.three_properties = [];
        this.three_nested_properties = [];
        this.datawidget_properties = [];

        this.enum_property_types = {};
        this.props_created_by_three = {};
        this.property_converters = {};
        this.property_assigners = {};
        this.property_mappers = {};

        this.initialized_from_three = {};
    }

    setupListeners() {

        // Handle changes in three instance props
        this.three_properties.forEach(function(propName) {
            // register listener for current child value
            var curValue = this.get(propName);
            if (curValue) {
                this.listenTo(curValue, 'change', this.onChildChanged.bind(this));
                this.listenTo(curValue, 'childchange', this.onChildChanged.bind(this));
            }

            // make sure to (un)hook listeners when child points to new object
            this.on('change:' + propName, function(model, value) {
                var prevModel = this.previous(propName);
                var currModel = value;
                if (prevModel) {
                    this.stopListening(prevModel);
                }
                if (currModel) {
                    this.listenTo(currModel, 'change', this.onChildChanged.bind(this));
                    this.listenTo(currModel, 'childchange', this.onChildChanged.bind(this));
                }
            }, this);
        }, this);

        // Handle changes in three instance nested props (arrays/dicts, possibly nested)
        listenNested(this, this.three_nested_properties, this.onChildChanged.bind(this));

        // Handle changes in data widgets/union properties
        this.datawidget_properties.forEach(function(propName) {
            dataserializers.listenToUnion(this, propName, this.onDataChanged.bind(this), false);
        }, this);

        this.on('change', this.onChange, this);
        this.on('msg:custom', this.onCustomMessage, this);
        this.on('destroy', this.onDestroy, this);

    }

    processNewObj(obj) {

        obj.ipymodelId = this.model_id; // brand that sucker
        obj.ipymodel = this;

        this.obj = obj;
        return obj;

    }

    createUninitializedChildren() {

        // Get any properties to create from this side
        var uninit = _.filter(this.three_properties, function(propName) {
            return this.get(propName) === 'uninitialized';
        }, this);

        // Return promise for their creation
        return Promise.all(_.map(uninit, function(propName) {
            this.initialized_from_three[propName] = true;
            var obj = this.obj[propName];
            // First, we need to figure out which model constructor to use
            var ctorName = utils.lookupThreeConstructorName(obj) + 'Model';
            var index = require('../');
            var ctor = index[ctorName];
            // Create the model
            var modelPromise = utils.createModel(ctor, this.widget_manager, obj);
            return modelPromise;
        }, this));
    }

    createThreeObjectAsync() {

        var objPromise;

        // call constructor method overridden by every class
        // check for custom async three obj creator
        if (this.constructThreeObjectAsync) {
            objPromise = this.constructThreeObjectAsync();
        } else if (this.constructThreeObject) {
            objPromise = Promise.resolve(this.constructThreeObject());
        } else {
            throw new Error('no THREE construct method exists: this.createThreeObjectAsync');
        }

        return objPromise.bind(this).then(this.processNewObj);

    }

    // Over-ride this method to customize how THREE object is created

    constructThreeObject() {}

    onDestroy() {
        if (this.obj) {
            if (this.obj.dispose) {
                this.obj.dispose();
            }
            delete this.obj;
        }
    }


    //
    // Remote execution of three.js object methods
    //

    onCustomMessage(content, buffers) {
        switch(content.type) {
        case 'exec_three_obj_method':
            this.onExecThreeObjMethod(content.method_name, content.args, content.buffers);
            break;
        case 'freeze':
            break;
        case 'print':
            console.log('SERVER: ' + JSON.stringify(content.msg));
            break;
        default:
            console.error('ERROR: invalid custom message', content);
        }
    }

    onExecThreeObjMethod(methodName, args, buffers) {
        console.debug('execThreeObjMethod: ' + methodName +
            '(' + args.map(JSON.stringify).join(',') + ')');

        if (!(methodName in this.obj)) {
            throw new Error('Invalid methodName: ' + methodName);
        }

        // convert serialized args to three.js compatible values
        args = args.map(function(arg) {

            if (Array.isArray(arg)) {

                if (arg.length === 2) {
                    return new THREE.Vector2().fromArray(arg);
                } else if (arg.length === 3) {
                    return new THREE.Vector3().fromArray(arg);
                } else if (arg.length === 4) {
                    return new THREE.Vector4().fromArray(arg);
                } else if (arg.length === 9) {
                    return new THREE.Matrix3().fromArray(arg);
                } else if (arg.length === 16) {
                    return new THREE.Matrix4().fromArray(arg);
                } else {
                    return arg;
                }

            } else if (typeof arg === 'string' && /IPY_MODEL_/.test(arg)) {

                arg = arg.replace('IPY_MODEL_', '');
                return this.widget_manager.get_model(arg).then(function(model) {
                    return model.obj;
                });

            } else {
                return arg;
            }

        }, this);

        return Promise.all(args).bind(this).then(function(args) {

            var retVal = this.obj[methodName].apply(this.obj, args);

            this.syncToModel(true);

            if (retVal !== null && retVal !== undefined) {

                if (retVal.ipymodel) {
                    retVal = retVal.ipymodel;
                }

                console.debug('sending return value to server...');
                this.send({
                    type: 'exec_three_obj_method_retval',
                    method_name: methodName,
                    ret_val: retVal,
                }, this.callbacks(), null);
            }

        });

    }

    //
    // Data-binding methods for syncing between model and three.js object
    //

    onChange(model, options) {
        if (options !== 'pushFromThree') {
            this.syncToThreeObj();
            // Also sync back out any generated properties:
            this.syncToModel();
        }
    }

    onChildChanged(model) {
        console.debug('child changed: ' + model.model_id);
        // Propagate up hierarchy:
        this.trigger('childchange', this);
    }

    onDataChanged(model, options) {
        console.debug('child data changed: ' + model.model_id);
        // Treat a data widget change as if data attribute changed
        // Note: hasChanged() etc won't identify the attribute, so
        // property_mappers should be used for union properties.
        this.onChange(model, options);
        // Propagate up hierarchy:
        this.trigger('childchange', this);
    }

    // push data from model to three object
    syncToThreeObj(force) {

        _.each(this.property_converters, function(converterName, propName) {
            if (!force && !this.hasChanged(propName)) {
                // Only set changed properties unless forced
                return;
            }
            var assigner = this[this.property_assigners[propName]] || this.assignDirect;
            assigner = assigner.bind(this);
            if (!converterName) {
                assigner(this.obj, propName, this.get(propName));
                return;
            }

            converterName = converterName + 'ModelToThree';
            var converterFn = this[converterName];
            if (!converterFn) {
                throw new Error('invalid converter name: ' + converterName);
            }
            assigner(this.obj, propName, converterFn.bind(this)(this.get(propName), propName));
        }, this);

        // mappers are used for more complicated conversions between model and three props
        // see: DataTexture
        _.each(this.property_mappers, function(mapperName) {
            if (!mapperName) {
                throw new Error('invalid mapper name: ' + mapperName);
            }

            mapperName = mapperName + 'ModelToThree';
            var mapperFn = this[mapperName];
            if (!mapperFn) {
                throw new Error('invalid mapper name: ' + mapperName);
            }

            mapperFn.bind(this)();
        }, this);
    }

    // push data from three object to model
    syncToModel(syncAllProps) {

        syncAllProps = syncAllProps === null ? false : syncAllProps;

        // Collect all the keys to set in one go
        var toSet = {};

        _.each(this.property_converters, function(converterName, propName) {
            if (!syncAllProps && !(propName in this.props_created_by_three)) {
                if (this.initialized_from_three[propName]) {
                    delete this.initialized_from_three[propName];
                } else {
                    return;
                }
            }

            if (!converterName) {
                toSet[propName] = this.obj[propName];
                return;
            }

            converterName = converterName + 'ThreeToModel';
            var converterFn = this[converterName];
            if (!converterFn) {
                throw new Error('invalid converter name: ' + converterName);
            }

            toSet[propName] = converterFn.bind(this)(this.obj[propName], propName);
        }, this);

        if (Object.keys(toSet).length) {
            // Apply all direct changes at once
            this.set(toSet, 'pushFromThree');
        }

        // mappers are used for more complicated conversions between model and three props
        // see: DataTexture
        _.each(this.property_mappers, function(mapperName, dataKey) {
            if (!mapperName) {
                throw new Error('invalid mapper name: ' + mapperName);
            }

            mapperName = mapperName + 'ThreeToModel';
            var mapperFn = this[mapperName];
            if (!mapperFn) {
                throw new Error('invalid mapper name: ' + mapperName);
            }

            mapperFn.bind(this)(dataKey);
        }, this);

        this.save_changes();
    }

    //
    // Conversions
    //

    assignDirect(obj, key, value) {
        obj[key] = value;
    }

    /**
     * Check if array exists, if so replace content. Otherwise assign value.
     */
    assignArray(obj, key, value) {
        var existing = obj[key];
        if (existing !== null && existing !== undefined) {
            // existing.splice(0, existing.length, ...value);
            existing.splice.apply(existing, [0, existing.length].concat(value));
        } else {
            obj[key] = value;
        }
    }

    // Float
    convertFloatModelToThree(v) {
        if (typeof v === 'string' || v instanceof String) {
            v = v.toLowerCase();
            if (v === 'inf') {
                return Infinity;
            } else if (v === '-inf') {
                return -Infinity;
            } else if (v === 'nan') {
                return NaN;
            }
        }
        return v;
    }

    convertFloatThreeToModel(v) {
        if (Number.isFinite(v)) { // Most common first
            return v;
        } else if (Number.isNaN(v)) {
            return 'nan';
        } else if (v === Infinity) {
            return 'inf';
        } else if (v === -Infinity) {
            return '-inf';
        }
        return v;
    }

    // Bool
    convertBoolModelToThree(v) {
        return v;
    }

    convertBoolThreeToModel(v) {
        if (v === null) {
            return null;
        }
        // Coerce falsy/truthy:
        return !!v;
    }

    // Enum
    convertEnumModelToThree(e) {
        if (e === null) {
            return null;
        }
        return THREE[e];
    }

    convertEnumThreeToModel(e, propName) {
        if (e === null) {
            return null;
        }
        var enumType = this.enum_property_types[propName];
        var enumValues = Enums[enumType];
        var enumValueName = enumValues[e];
        return enumValueName;
    }

    // Vectors
    convertVectorModelToThree(v) {
        var result;
        switch(v.length) {
        case 2: result = new THREE.Vector2(); break;
        case 3: result = new THREE.Vector3(); break;
        case 4: result = new THREE.Vector4(); break;
        default:
            throw new Error('model vector has invalid length: ' + v.length);
        }
        result.fromArray(v.map(this.convertFloatModelToThree));
        return result;
    }

    convertVectorThreeToModel(v) {
        return v.toArray().map(this.convertFloatThreeToModel);
    }

    assignVector(obj, key, value) {
        obj[key].copy(value);
    }

    // Euler
    convertEulerModelToThree(v) {
        // The float conversions will ignore the "XYZ" order strings
        return new THREE.Euler().fromArray(v.map(this.convertFloatModelToThree));
    }

    convertEulerThreeToModel(v) {
        // The float conversions will ignore the "XYZ" order strings
        return v.toArray().map(this.convertFloatThreeToModel);
    }

    assignEuler(obj, key, value) {
        obj[key].copy(value);
    }

    // Vector Array
    convertVectorArrayModelToThree(varr, propName) {
        return varr.map(function(v) {
            return this.convertVectorModelToThree(v, propName);
        }, this);
    }

    convertVectorArrayThreeToModel(varr, propName) {
        return varr.map(function(v) {
            return this.convertVectorThreeToModel(v, propName);
        }, this);
    }

    // Color Array
    convertColorArrayModelToThree(carr, propName) {
        return carr.map(function(c) {
            return this.convertColorModelToThree(c, propName);
        }, this);
    }

    convertColorArrayThreeToModel(carr, propName) {
        return carr.map(function(c) {
            return this.convertColorThreeToModel(c, propName);
        }, this);
    }

    // Faces
    convertFaceModelToThree(f) {
        var normal = f[3];
        if (normal !== undefined && normal !== null) {
            if (Array.isArray(normal) && normal.length > 0 && Array.isArray(normal[0])) {
                normal = normal.map(function (value) {
                    return this.convertVectorModelToThree(value);
                }, this);
            } else {
                normal = this.convertVectorModelToThree(normal);
            }
        }
        var color = f[4];
        if (color !== undefined && color !== null) {
            if (Array.isArray(color)) {
                color = color.map(function (value) {
                    return new THREE.Color(value);
                }, this);
            } else {
                color = new THREE.Color(color);
            }
        }
        var result = new THREE.Face3(
            f[0],                                           // a
            f[1],                                           // b
            f[2],                                           // c
            normal,                                         // normal
            color,                                          // color
            f[5]                                            // materialIndex
        );

        return result;
    }

    convertFaceThreeToModel(f) {
        return [
            f.a,
            f.b,
            f.c,
            f.vertexNormals.length > 0
                ? this.convertVectorArrayThreeToModel(f.vertexNormals)
                : f.normal.toArray(),
            f.vertexColors.length > 0
                ? this.convertColorArrayThreeToModel(f.vertexColors)
                : this.convertColorThreeToModel(f.color),
            f.materialIndex,
        ];
    }

    // Face Array
    convertFaceArrayModelToThree(farr, propName) {
        return farr.map(function(f) {
            return this.convertFaceModelToThree(f, propName);
        }, this);
    }

    convertFaceArrayThreeToModel(farr, propName) {
        return farr.map(function(f) {
            return this.convertFaceThreeToModel(f, propName);
        }, this);
    }

    // Matrices
    convertMatrixModelToThree(m) {
        var result;
        switch(m.length) {
        case 9: result = new THREE.Matrix3(); break;
        case 16: result = new THREE.Matrix4(); break;
        default:
            throw new Error('model matrix has invalid length: ' + m.length);
        }
        result.fromArray(m.map(this.convertFloatModelToThree));
        return result;
    }

    convertMatrixThreeToModel(m) {
        return m.toArray().map(this.convertFloatThreeToModel);
    }

    assignMatrix(obj, key, value) {
        obj[key].copy(value);
    }

    // Functions
    convertFunctionModelToThree(fnStr) {
        var fn;
        eval('fn = ' + fnStr);
        return fn;
    }

    convertFunctionThreeToModelToThree(fn) {
        return fn.toString();
    }

    // ThreeType
    convertThreeTypeModelToThree(model) {
        if (model) {
            return model.obj;
        }
        return null;
    }

    convertThreeTypeThreeToModel(threeType) {
        if (!threeType) {
            return threeType;
        }
        return threeType.ipymodel;
    }

    // Dict
    assignDict(obj, key, value) {
        if (obj[key] === value) {
            // If instance equality, do nothing.
            return;
        }
        if (obj[key] === undefined || obj[key] === null) {
            if (value === null || value === undefined) {
                // Leave it as it is
                return;
            }
            obj[key] = {};
        }
        // Clear the dict
        Object.keys(obj[key]).forEach(function(k) {
            delete obj[key][k];
        });
        // Put in the new values
        Object.assign(obj[key], value);
    }

    // ThreeTypeArray
    convertThreeTypeArrayModelToThree(modelArr, propName) {
        if (!Array.isArray(modelArr)) {
            return this.convertThreeTypeModelToThree(modelArr, propName);
        }
        return modelArr.map(function(model) {
            return this.convertThreeTypeModelToThree(model, propName);
        }, this);
    }

    convertThreeTypeArrayThreeToModel(threeTypeArr, propName) {
        if (!Array.isArray(threeTypeArr)) {
            return this.convertThreeTypeThreeToModel(threeTypeArr, propName);
        }
        return threeTypeArr.map(function(threeType) {
            return this.convertThreeTypeThreeToModel(threeType, propName);
        }, this);
    }

    // ThreeTypeDict
    convertThreeTypeDictModelToThree(modelDict, propName) {
        return _.mapObject(modelDict, function(model) {
            return this.convertThreeTypeModelToThree(model, propName);
        }, this);
    }

    convertThreeTypeDictThreeToModel(threeTypeDict, propName) {
        return _.mapObject(threeTypeDict, function(threeType) {
            return this.convertThreeTypeThreeToModel(threeType, propName);
        }, this);
    }

    // BufferMorphAttributes
    convertMorphAttributesModelToThree(modelDict, propName) {
        return _.mapObject(modelDict, function(arr) {
            return arr.map(function(model) {
                return this.convertThreeTypeModelToThree(model, propName);
            }, this);
        }, this);
    }

    convertMorphAttributesThreeToModel(threeTypeDict, propName) {
        return _.mapObject(threeTypeDict, function(arr) {
            return arr.map(function(model) {
                return this.convertThreeTypeThreeToModel(model, propName);
            }, this);
        }, this);
    }

    // ArrayBuffer
    convertArrayBufferModelToThree(ref, propName) {
        var arr = dataserializers.getArray(ref);
        return arr && arr.data;
    }

    convertArrayBufferThreeToModel(arrBuffer, propName) {
        if (arrBuffer === null) {
            return null;
        }
        var current = this.get(propName);
        var currentArray = dataserializers.getArray(current);
        if (currentArray && (currentArray.data === arrBuffer)) {
            // Unchanged, do nothing
            return current;
        }
        // Never create a new widget, even if current is one
        return ndarray(arrBuffer);
    }

    // Color
    convertColorModelToThree(c) {
        if (c === null) {
            return null;
        }
        return new THREE.Color(c);
    }

    convertColorThreeToModel(c) {
        if (c === null) {
            return null;
        }
        return '#' + c.getHexString();
    }

}

ThreeModel.model_module = 'jupyter-threejs';
ThreeModel.model_name = 'ThreeModel';
ThreeModel.model_module_version = EXTENSION_SPEC_VERSION;

module.exports = {
    ThreeModel: ThreeModel,
};
