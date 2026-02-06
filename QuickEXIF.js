
// ==UserScript==
// @name         Commons EXIF Editor
// @description  Edit select EXIF metadata directly on Wikimedia Commons file pages and re-upload with modified data
// @namespace    https://commons.wikimedia.org/
// @match        https://commons.wikimedia.org/wiki/File:*
// @author       Kevin Payravi / WikiPortraits
// ==/UserScript==

// This script uses the piexifjs library for EXIF manipulation
// https://github.com/hMatoba/piexifjs
// Exported 2026-01-31
// "End of piexifjs" comment marks the end of the library code
/* piexifjs

The MIT License (MIT)

Copyright (c) 2014, 2015 hMatoba(https://github.com/hMatoba)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

(function () {
    "use strict";
    var that = {};
    that.version = "1.0.4";

    that.remove = function (jpeg) {
        var b64 = false;
        if (jpeg.slice(0, 2) == "\xff\xd8") {
        } else if (jpeg.slice(0, 23) == "data:image/jpeg;base64," || jpeg.slice(0, 22) == "data:image/jpg;base64,") {
            jpeg = atob(jpeg.split(",")[1]);
            b64 = true;
        } else {
            throw new Error("Given data is not jpeg.");
        }

        var segments = splitIntoSegments(jpeg);
        var newSegments = segments.filter(function (seg) {
            return !(seg.slice(0, 2) == "\xff\xe1" &&
                seg.slice(4, 10) == "Exif\x00\x00");
        });

        var new_data = newSegments.join("");
        if (b64) {
            new_data = "data:image/jpeg;base64," + btoa(new_data);
        }

        return new_data;
    };


    that.insert = function (exif, jpeg) {
        var b64 = false;
        if (exif.slice(0, 6) != "\x45\x78\x69\x66\x00\x00") {
            throw new Error("Given data is not exif.");
        }
        if (jpeg.slice(0, 2) == "\xff\xd8") {
        } else if (jpeg.slice(0, 23) == "data:image/jpeg;base64," || jpeg.slice(0, 22) == "data:image/jpg;base64,") {
            jpeg = atob(jpeg.split(",")[1]);
            b64 = true;
        } else {
            throw new Error("Given data is not jpeg.");
        }

        var exifStr = "\xff\xe1" + pack(">H", [exif.length + 2]) + exif;
        var segments = splitIntoSegments(jpeg);
        var new_data = mergeSegments(segments, exifStr);
        if (b64) {
            new_data = "data:image/jpeg;base64," + btoa(new_data);
        }

        return new_data;
    };


    that.load = function (data) {
        var input_data;
        if (typeof (data) == "string") {
            if (data.slice(0, 2) == "\xff\xd8") {
                input_data = data;
            } else if (data.slice(0, 23) == "data:image/jpeg;base64," || data.slice(0, 22) == "data:image/jpg;base64,") {
                input_data = atob(data.split(",")[1]);
            } else if (data.slice(0, 4) == "Exif") {
                input_data = data.slice(6);
            } else {
                throw new Error("'load' gots invalid file data.");
            }
        } else {
            throw new Error("'load' gots invalid type argument.");
        }

        var exifDict = {};
        var exif_dict = {
            "0th": {},
            "Exif": {},
            "GPS": {},
            "Interop": {},
            "1st": {},
            "thumbnail": null
        };
        var exifReader = new ExifReader(input_data);
        if (exifReader.tiftag === null) {
            return exif_dict;
        }

        if (exifReader.tiftag.slice(0, 2) == "\x49\x49") {
            exifReader.endian_mark = "<";
        } else {
            exifReader.endian_mark = ">";
        }

        var pointer = unpack(exifReader.endian_mark + "L",
            exifReader.tiftag.slice(4, 8))[0];
        exif_dict["0th"] = exifReader.get_ifd(pointer, "0th");

        var first_ifd_pointer = exif_dict["0th"]["first_ifd_pointer"];
        delete exif_dict["0th"]["first_ifd_pointer"];

        if (34665 in exif_dict["0th"]) {
            pointer = exif_dict["0th"][34665];
            exif_dict["Exif"] = exifReader.get_ifd(pointer, "Exif");
        }
        if (34853 in exif_dict["0th"]) {
            pointer = exif_dict["0th"][34853];
            exif_dict["GPS"] = exifReader.get_ifd(pointer, "GPS");
        }
        if (40965 in exif_dict["Exif"]) {
            pointer = exif_dict["Exif"][40965];
            exif_dict["Interop"] = exifReader.get_ifd(pointer, "Interop");
        }
        if (first_ifd_pointer != "\x00\x00\x00\x00") {
            pointer = unpack(exifReader.endian_mark + "L",
                first_ifd_pointer)[0];
            exif_dict["1st"] = exifReader.get_ifd(pointer, "1st");
            if ((513 in exif_dict["1st"]) && (514 in exif_dict["1st"])) {
                var end = exif_dict["1st"][513] + exif_dict["1st"][514];
                var thumb = exifReader.tiftag.slice(exif_dict["1st"][513], end);
                exif_dict["thumbnail"] = thumb;
            }
        }

        return exif_dict;
    };


    that.dump = function (exif_dict_original) {
        var TIFF_HEADER_LENGTH = 8;

        var exif_dict = copy(exif_dict_original);
        var header = "Exif\x00\x00\x4d\x4d\x00\x2a\x00\x00\x00\x08";
        var exif_is = false;
        var gps_is = false;
        var interop_is = false;
        var first_is = false;

        var zeroth_ifd,
            exif_ifd,
            interop_ifd,
            gps_ifd,
            first_ifd;

        if ("0th" in exif_dict) {
            zeroth_ifd = exif_dict["0th"];
        } else {
            zeroth_ifd = {};
        }

        if ((("Exif" in exif_dict) && (Object.keys(exif_dict["Exif"]).length)) ||
            (("Interop" in exif_dict) && (Object.keys(exif_dict["Interop"]).length))) {
            zeroth_ifd[34665] = 1;
            exif_is = true;
            exif_ifd = exif_dict["Exif"];
            if (("Interop" in exif_dict) && Object.keys(exif_dict["Interop"]).length) {
                exif_ifd[40965] = 1;
                interop_is = true;
                interop_ifd = exif_dict["Interop"];
            } else if (Object.keys(exif_ifd).indexOf(that.ExifIFD.InteroperabilityTag.toString()) > -1) {
                delete exif_ifd[40965];
            }
        } else if (Object.keys(zeroth_ifd).indexOf(that.ImageIFD.ExifTag.toString()) > -1) {
            delete zeroth_ifd[34665];
        }

        if (("GPS" in exif_dict) && (Object.keys(exif_dict["GPS"]).length)) {
            zeroth_ifd[that.ImageIFD.GPSTag] = 1;
            gps_is = true;
            gps_ifd = exif_dict["GPS"];
        } else if (Object.keys(zeroth_ifd).indexOf(that.ImageIFD.GPSTag.toString()) > -1) {
            delete zeroth_ifd[that.ImageIFD.GPSTag];
        }

        if (("1st" in exif_dict) &&
            ("thumbnail" in exif_dict) &&
            (exif_dict["thumbnail"] != null)) {
            first_is = true;
            exif_dict["1st"][513] = 1;
            exif_dict["1st"][514] = 1;
            first_ifd = exif_dict["1st"];
        }

        var zeroth_set = _dict_to_bytes(zeroth_ifd, "0th", 0);
        var zeroth_length = (zeroth_set[0].length + exif_is * 12 + gps_is * 12 + 4 +
            zeroth_set[1].length);

        var exif_set,
            exif_bytes = "",
            exif_length = 0,
            gps_set,
            gps_bytes = "",
            gps_length = 0,
            interop_set,
            interop_bytes = "",
            interop_length = 0,
            first_set,
            first_bytes = "",
            thumbnail;
        if (exif_is) {
            exif_set = _dict_to_bytes(exif_ifd, "Exif", zeroth_length);
            exif_length = exif_set[0].length + interop_is * 12 + exif_set[1].length;
        }
        if (gps_is) {
            gps_set = _dict_to_bytes(gps_ifd, "GPS", zeroth_length + exif_length);
            gps_bytes = gps_set.join("");
            gps_length = gps_bytes.length;
        }
        if (interop_is) {
            var offset = zeroth_length + exif_length + gps_length;
            interop_set = _dict_to_bytes(interop_ifd, "Interop", offset);
            interop_bytes = interop_set.join("");
            interop_length = interop_bytes.length;
        }
        if (first_is) {
            var offset = zeroth_length + exif_length + gps_length + interop_length;
            first_set = _dict_to_bytes(first_ifd, "1st", offset);
            thumbnail = _get_thumbnail(exif_dict["thumbnail"]);
            if (thumbnail.length > 64000) {
                throw new Error("Given thumbnail is too large. max 64kB");
            }
        }

        var exif_pointer = "",
            gps_pointer = "",
            interop_pointer = "",
            first_ifd_pointer = "\x00\x00\x00\x00";
        if (exif_is) {
            var pointer_value = TIFF_HEADER_LENGTH + zeroth_length;
            var pointer_str = pack(">L", [pointer_value]);
            var key = 34665;
            var key_str = pack(">H", [key]);
            var type_str = pack(">H", [TYPES["Long"]]);
            var length_str = pack(">L", [1]);
            exif_pointer = key_str + type_str + length_str + pointer_str;
        }
        if (gps_is) {
            var pointer_value = TIFF_HEADER_LENGTH + zeroth_length + exif_length;
            var pointer_str = pack(">L", [pointer_value]);
            var key = 34853;
            var key_str = pack(">H", [key]);
            var type_str = pack(">H", [TYPES["Long"]]);
            var length_str = pack(">L", [1]);
            gps_pointer = key_str + type_str + length_str + pointer_str;
        }
        if (interop_is) {
            var pointer_value = (TIFF_HEADER_LENGTH +
                zeroth_length + exif_length + gps_length);
            var pointer_str = pack(">L", [pointer_value]);
            var key = 40965;
            var key_str = pack(">H", [key]);
            var type_str = pack(">H", [TYPES["Long"]]);
            var length_str = pack(">L", [1]);
            interop_pointer = key_str + type_str + length_str + pointer_str;
        }
        if (first_is) {
            var pointer_value = (TIFF_HEADER_LENGTH + zeroth_length +
                exif_length + gps_length + interop_length);
            first_ifd_pointer = pack(">L", [pointer_value]);
            var thumbnail_pointer = (pointer_value + first_set[0].length + 24 +
                4 + first_set[1].length);
            var thumbnail_p_bytes = ("\x02\x01\x00\x04\x00\x00\x00\x01" +
                pack(">L", [thumbnail_pointer]));
            var thumbnail_length_bytes = ("\x02\x02\x00\x04\x00\x00\x00\x01" +
                pack(">L", [thumbnail.length]));
            first_bytes = (first_set[0] + thumbnail_p_bytes +
                thumbnail_length_bytes + "\x00\x00\x00\x00" +
                first_set[1] + thumbnail);
        }

        var zeroth_bytes = (zeroth_set[0] + exif_pointer + gps_pointer +
            first_ifd_pointer + zeroth_set[1]);
        if (exif_is) {
            exif_bytes = exif_set[0] + interop_pointer + exif_set[1];
        }

        return (header + zeroth_bytes + exif_bytes + gps_bytes +
            interop_bytes + first_bytes);
    };


    function copy(obj) {
        return JSON.parse(JSON.stringify(obj));
    }


    function _get_thumbnail(jpeg) {
        var segments = splitIntoSegments(jpeg);
        while (("\xff\xe0" <= segments[1].slice(0, 2)) && (segments[1].slice(0, 2) <= "\xff\xef")) {
            segments = [segments[0]].concat(segments.slice(2));
        }
        return segments.join("");
    }


    function _pack_byte(array) {
        return pack(">" + nStr("B", array.length), array);
    }


    function _pack_short(array) {
        return pack(">" + nStr("H", array.length), array);
    }


    function _pack_long(array) {
        return pack(">" + nStr("L", array.length), array);
    }


    function _value_to_bytes(raw_value, value_type, offset) {
        var four_bytes_over = "";
        var value_str = "";
        var length,
            new_value,
            num,
            den;

        if (value_type == "Byte") {
            length = raw_value.length;
            if (length <= 4) {
                value_str = (_pack_byte(raw_value) +
                    nStr("\x00", 4 - length));
            } else {
                value_str = pack(">L", [offset]);
                four_bytes_over = _pack_byte(raw_value);
            }
        } else if (value_type == "Short") {
            length = raw_value.length;
            if (length <= 2) {
                value_str = (_pack_short(raw_value) +
                    nStr("\x00\x00", 2 - length));
            } else {
                value_str = pack(">L", [offset]);
                four_bytes_over = _pack_short(raw_value);
            }
        } else if (value_type == "Long") {
            length = raw_value.length;
            if (length <= 1) {
                value_str = _pack_long(raw_value);
            } else {
                value_str = pack(">L", [offset]);
                four_bytes_over = _pack_long(raw_value);
            }
        } else if (value_type == "Ascii") {
            new_value = raw_value + "\x00";
            length = new_value.length;
            if (length > 4) {
                value_str = pack(">L", [offset]);
                four_bytes_over = new_value;
            } else {
                value_str = new_value + nStr("\x00", 4 - length);
            }
        } else if (value_type == "Rational") {
            if (typeof (raw_value[0]) == "number") {
                length = 1;
                num = raw_value[0];
                den = raw_value[1];
                new_value = pack(">L", [num]) + pack(">L", [den]);
            } else {
                length = raw_value.length;
                new_value = "";
                for (var n = 0; n < length; n++) {
                    num = raw_value[n][0];
                    den = raw_value[n][1];
                    new_value += (pack(">L", [num]) +
                        pack(">L", [den]));
                }
            }
            value_str = pack(">L", [offset]);
            four_bytes_over = new_value;
        } else if (value_type == "SRational") {
            if (typeof (raw_value[0]) == "number") {
                length = 1;
                num = raw_value[0];
                den = raw_value[1];
                new_value = pack(">l", [num]) + pack(">l", [den]);
            } else {
                length = raw_value.length;
                new_value = "";
                for (var n = 0; n < length; n++) {
                    num = raw_value[n][0];
                    den = raw_value[n][1];
                    new_value += (pack(">l", [num]) +
                        pack(">l", [den]));
                }
            }
            value_str = pack(">L", [offset]);
            four_bytes_over = new_value;
        } else if (value_type == "Undefined") {
            length = raw_value.length;
            if (length > 4) {
                value_str = pack(">L", [offset]);
                four_bytes_over = raw_value;
            } else {
                value_str = raw_value + nStr("\x00", 4 - length);
            }
        }

        var length_str = pack(">L", [length]);

        return [length_str, value_str, four_bytes_over];
    }

    function _dict_to_bytes(ifd_dict, ifd, ifd_offset) {
        var TIFF_HEADER_LENGTH = 8;
        var tag_count = Object.keys(ifd_dict).length;
        var entry_header = pack(">H", [tag_count]);
        var entries_length;
        if (["0th", "1st"].indexOf(ifd) > -1) {
            entries_length = 2 + tag_count * 12 + 4;
        } else {
            entries_length = 2 + tag_count * 12;
        }
        var entries = "";
        var values = "";
        var key;

        // Sort keys to ensure TIFF compliance (SAFE FIX: ensures explicit order matches appended pointers)
        var keys = Object.keys(ifd_dict).map(function (x) { return parseInt(x); });
        keys.sort(function (a, b) { return a - b; });

        for (var i = 0; i < keys.length; i++) {
            key = keys[i];

            if ((ifd == "0th") && ([34665, 34853].indexOf(key) > -1)) {
                continue;
            } else if ((ifd == "Exif") && (key == 40965)) {
                continue;
            } else if ((ifd == "1st") && ([513, 514].indexOf(key) > -1)) {
                continue;
            }

            var raw_value = ifd_dict[key];
            var key_str = pack(">H", [key]);
            var value_type = TAGS[ifd][key]["type"];
            var type_str = pack(">H", [TYPES[value_type]]);

            if (typeof (raw_value) == "number") {
                raw_value = [raw_value];
            }
            var offset = TIFF_HEADER_LENGTH + entries_length + ifd_offset + values.length;
            var b = _value_to_bytes(raw_value, value_type, offset);
            var length_str = b[0];
            var value_str = b[1];
            var four_bytes_over = b[2];

            entries += key_str + type_str + length_str + value_str;
            values += four_bytes_over;

            // Pad values to ensure word alignment (even offsets)
            if (values.length % 2 !== 0) {
                values += "\x00";
            }
        }

        return [entry_header + entries, values];
    }



    function ExifReader(data) {
        var segments,
            app1;
        if (data.slice(0, 2) == "\xff\xd8") { // JPEG
            segments = splitIntoSegments(data);
            app1 = getExifSeg(segments);
            if (app1) {
                this.tiftag = app1.slice(10);
            } else {
                this.tiftag = null;
            }
        } else if (["\x49\x49", "\x4d\x4d"].indexOf(data.slice(0, 2)) > -1) { // TIFF
            this.tiftag = data;
        } else if (data.slice(0, 4) == "Exif") { // Exif
            this.tiftag = data.slice(6);
        } else {
            throw new Error("Given file is neither JPEG nor TIFF.");
        }
    }

    ExifReader.prototype = {
        get_ifd: function (pointer, ifd_name) {
            var ifd_dict = {};
            var tag_count = unpack(this.endian_mark + "H",
                this.tiftag.slice(pointer, pointer + 2))[0];
            var offset = pointer + 2;
            var t;
            if (["0th", "1st"].indexOf(ifd_name) > -1) {
                t = "Image";
            } else {
                t = ifd_name;
            }

            for (var x = 0; x < tag_count; x++) {
                pointer = offset + 12 * x;
                var tag = unpack(this.endian_mark + "H",
                    this.tiftag.slice(pointer, pointer + 2))[0];
                var value_type = unpack(this.endian_mark + "H",
                    this.tiftag.slice(pointer + 2, pointer + 4))[0];
                var value_num = unpack(this.endian_mark + "L",
                    this.tiftag.slice(pointer + 4, pointer + 8))[0];
                var value = this.tiftag.slice(pointer + 8, pointer + 12);

                var v_set = [value_type, value_num, value];
                if (tag in TAGS[t]) {
                    ifd_dict[tag] = this.convert_value(v_set);
                }
            }

            if (ifd_name == "0th") {
                pointer = offset + 12 * tag_count;
                ifd_dict["first_ifd_pointer"] = this.tiftag.slice(pointer, pointer + 4);
            }

            return ifd_dict;
        },

        convert_value: function (val) {
            var data = null;
            var t = val[0];
            var length = val[1];
            var value = val[2];
            var pointer;

            if (t == 1) { // BYTE
                if (length > 4) {
                    pointer = unpack(this.endian_mark + "L", value)[0];
                    data = unpack(this.endian_mark + nStr("B", length),
                        this.tiftag.slice(pointer, pointer + length));
                } else {
                    data = unpack(this.endian_mark + nStr("B", length), value.slice(0, length));
                }
            } else if (t == 2) { // ASCII
                if (length > 4) {
                    pointer = unpack(this.endian_mark + "L", value)[0];
                    data = this.tiftag.slice(pointer, pointer + length - 1);
                } else {
                    data = value.slice(0, length - 1);
                }
            } else if (t == 3) { // SHORT
                if (length > 2) {
                    pointer = unpack(this.endian_mark + "L", value)[0];
                    data = unpack(this.endian_mark + nStr("H", length),
                        this.tiftag.slice(pointer, pointer + length * 2));
                } else {
                    data = unpack(this.endian_mark + nStr("H", length),
                        value.slice(0, length * 2));
                }
            } else if (t == 4) { // LONG
                if (length > 1) {
                    pointer = unpack(this.endian_mark + "L", value)[0];
                    data = unpack(this.endian_mark + nStr("L", length),
                        this.tiftag.slice(pointer, pointer + length * 4));
                } else {
                    data = unpack(this.endian_mark + nStr("L", length),
                        value);
                }
            } else if (t == 5) { // RATIONAL
                pointer = unpack(this.endian_mark + "L", value)[0];
                if (length > 1) {
                    data = [];
                    for (var x = 0; x < length; x++) {
                        data.push([unpack(this.endian_mark + "L",
                            this.tiftag.slice(pointer + x * 8, pointer + 4 + x * 8))[0],
                        unpack(this.endian_mark + "L",
                            this.tiftag.slice(pointer + 4 + x * 8, pointer + 8 + x * 8))[0]
                        ]);
                    }
                } else {
                    data = [unpack(this.endian_mark + "L",
                        this.tiftag.slice(pointer, pointer + 4))[0],
                    unpack(this.endian_mark + "L",
                        this.tiftag.slice(pointer + 4, pointer + 8))[0]
                    ];
                }
            } else if (t == 7) { // UNDEFINED BYTES
                if (length > 4) {
                    pointer = unpack(this.endian_mark + "L", value)[0];
                    data = this.tiftag.slice(pointer, pointer + length);
                } else {
                    data = value.slice(0, length);
                }
            } else if (t == 9) { // SLONG
                if (length > 1) {
                    pointer = unpack(this.endian_mark + "L", value)[0];
                    data = unpack(this.endian_mark + nStr("l", length),
                        this.tiftag.slice(pointer, pointer + length * 4));
                } else {
                    data = unpack(this.endian_mark + nStr("l", length),
                        value);
                }
            } else if (t == 10) { // SRATIONAL
                pointer = unpack(this.endian_mark + "L", value)[0];
                if (length > 1) {
                    data = [];
                    for (var x = 0; x < length; x++) {
                        data.push([unpack(this.endian_mark + "l",
                            this.tiftag.slice(pointer + x * 8, pointer + 4 + x * 8))[0],
                        unpack(this.endian_mark + "l",
                            this.tiftag.slice(pointer + 4 + x * 8, pointer + 8 + x * 8))[0]
                        ]);
                    }
                } else {
                    data = [unpack(this.endian_mark + "l",
                        this.tiftag.slice(pointer, pointer + 4))[0],
                    unpack(this.endian_mark + "l",
                        this.tiftag.slice(pointer + 4, pointer + 8))[0]
                    ];
                }
            } else {
                throw new Error("Exif might be wrong. Got incorrect value " +
                    "type to decode. type:" + t);
            }

            if ((data instanceof Array) && (data.length == 1)) {
                return data[0];
            } else {
                return data;
            }
        },
    };


    if (typeof window !== "undefined" && typeof window.btoa === "function") {
        var btoa = window.btoa;
    }
    if (typeof btoa === "undefined") {
        var btoa = function (input) {
            var output = "";
            var chr1, chr2, chr3, enc1, enc2, enc3, enc4;
            var i = 0;
            var keyStr = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

            while (i < input.length) {

                chr1 = input.charCodeAt(i++);
                chr2 = input.charCodeAt(i++);
                chr3 = input.charCodeAt(i++);

                enc1 = chr1 >> 2;
                enc2 = ((chr1 & 3) << 4) | (chr2 >> 4);
                enc3 = ((chr2 & 15) << 2) | (chr3 >> 6);
                enc4 = chr3 & 63;

                if (isNaN(chr2)) {
                    enc3 = enc4 = 64;
                } else if (isNaN(chr3)) {
                    enc4 = 64;
                }

                output = output +
                    keyStr.charAt(enc1) + keyStr.charAt(enc2) +
                    keyStr.charAt(enc3) + keyStr.charAt(enc4);

            }

            return output;
        };
    }


    if (typeof window !== "undefined" && typeof window.atob === "function") {
        var atob = window.atob;
    }
    if (typeof atob === "undefined") {
        var atob = function (input) {
            var output = "";
            var chr1, chr2, chr3;
            var enc1, enc2, enc3, enc4;
            var i = 0;
            var keyStr = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

            input = input.replace(/[^A-Za-z0-9\+\/\=]/g, "");

            while (i < input.length) {

                enc1 = keyStr.indexOf(input.charAt(i++));
                enc2 = keyStr.indexOf(input.charAt(i++));
                enc3 = keyStr.indexOf(input.charAt(i++));
                enc4 = keyStr.indexOf(input.charAt(i++));

                chr1 = (enc1 << 2) | (enc2 >> 4);
                chr2 = ((enc2 & 15) << 4) | (enc3 >> 2);
                chr3 = ((enc3 & 3) << 6) | enc4;

                output = output + String.fromCharCode(chr1);

                if (enc3 != 64) {
                    output = output + String.fromCharCode(chr2);
                }
                if (enc4 != 64) {
                    output = output + String.fromCharCode(chr3);
                }

            }

            return output;
        };
    }


    function getImageSize(imageArray) {
        var segments = slice2Segments(imageArray);
        var seg,
            width,
            height,
            SOF = [192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207];

        for (var x = 0; x < segments.length; x++) {
            seg = segments[x];
            if (SOF.indexOf(seg[1]) >= 0) {
                height = seg[5] * 256 + seg[6];
                width = seg[7] * 256 + seg[8];
                break;
            }
        }
        return [width, height];
    }


    function pack(mark, array) {
        if (!(array instanceof Array)) {
            throw new Error("'pack' error. Got invalid type argument.");
        }
        if ((mark.length - 1) != array.length) {
            throw new Error("'pack' error. " + (mark.length - 1) + " marks, " + array.length + " elements.");
        }

        var littleEndian;
        if (mark[0] == "<") {
            littleEndian = true;
        } else if (mark[0] == ">") {
            littleEndian = false;
        } else {
            throw new Error("");
        }
        var packed = "";
        var p = 1;
        var val = null;
        var c = null;
        var valStr = null;

        while (c = mark[p]) {
            if (c.toLowerCase() == "b") {
                val = array[p - 1];
                if ((c == "b") && (val < 0)) {
                    val += 0x100;
                }
                if ((val > 0xff) || (val < 0)) {
                    throw new Error("'pack' error.");
                } else {
                    valStr = String.fromCharCode(val);
                }
            } else if (c == "H") {
                val = array[p - 1];
                if ((val > 0xffff) || (val < 0)) {
                    throw new Error("'pack' error.");
                } else {
                    valStr = String.fromCharCode(Math.floor((val % 0x10000) / 0x100)) +
                        String.fromCharCode(val % 0x100);
                    if (littleEndian) {
                        valStr = valStr.split("").reverse().join("");
                    }
                }
            } else if (c.toLowerCase() == "l") {
                val = array[p - 1];
                if ((c == "l") && (val < 0)) {
                    val += 0x100000000;
                }
                if ((val > 0xffffffff) || (val < 0)) {
                    throw new Error("'pack' error.");
                } else {
                    valStr = String.fromCharCode(Math.floor(val / 0x1000000)) +
                        String.fromCharCode(Math.floor((val % 0x1000000) / 0x10000)) +
                        String.fromCharCode(Math.floor((val % 0x10000) / 0x100)) +
                        String.fromCharCode(val % 0x100);
                    if (littleEndian) {
                        valStr = valStr.split("").reverse().join("");
                    }
                }
            } else {
                throw new Error("'pack' error.");
            }

            packed += valStr;
            p += 1;
        }

        return packed;
    }

    function unpack(mark, str) {
        if (typeof (str) != "string") {
            throw new Error("'unpack' error. Got invalid type argument.");
        }
        var l = 0;
        for (var markPointer = 1; markPointer < mark.length; markPointer++) {
            if (mark[markPointer].toLowerCase() == "b") {
                l += 1;
            } else if (mark[markPointer].toLowerCase() == "h") {
                l += 2;
            } else if (mark[markPointer].toLowerCase() == "l") {
                l += 4;
            } else {
                throw new Error("'unpack' error. Got invalid mark.");
            }
        }

        if (l != str.length) {
            throw new Error("'unpack' error. Mismatch between symbol and string length. " + l + ":" + str.length);
        }

        var littleEndian;
        if (mark[0] == "<") {
            littleEndian = true;
        } else if (mark[0] == ">") {
            littleEndian = false;
        } else {
            throw new Error("'unpack' error.");
        }
        var unpacked = [];
        var strPointer = 0;
        var p = 1;
        var val = null;
        var c = null;
        var length = null;
        var sliced = "";

        while (c = mark[p]) {
            if (c.toLowerCase() == "b") {
                length = 1;
                sliced = str.slice(strPointer, strPointer + length);
                val = sliced.charCodeAt(0);
                if ((c == "b") && (val >= 0x80)) {
                    val -= 0x100;
                }
            } else if (c == "H") {
                length = 2;
                sliced = str.slice(strPointer, strPointer + length);
                if (littleEndian) {
                    sliced = sliced.split("").reverse().join("");
                }
                val = sliced.charCodeAt(0) * 0x100 +
                    sliced.charCodeAt(1);
            } else if (c.toLowerCase() == "l") {
                length = 4;
                sliced = str.slice(strPointer, strPointer + length);
                if (littleEndian) {
                    sliced = sliced.split("").reverse().join("");
                }
                val = sliced.charCodeAt(0) * 0x1000000 +
                    sliced.charCodeAt(1) * 0x10000 +
                    sliced.charCodeAt(2) * 0x100 +
                    sliced.charCodeAt(3);
                if ((c == "l") && (val >= 0x80000000)) {
                    val -= 0x100000000;
                }
            } else {
                throw new Error("'unpack' error. " + c);
            }

            unpacked.push(val);
            strPointer += length;
            p += 1;
        }

        return unpacked;
    }

    function nStr(ch, num) {
        var str = "";
        for (var i = 0; i < num; i++) {
            str += ch;
        }
        return str;
    }

    function splitIntoSegments(data) {
        if (data.slice(0, 2) != "\xff\xd8") {
            throw new Error("Given data isn't JPEG.");
        }

        var head = 2;
        var segments = ["\xff\xd8"];
        while (true) {
            if (data.slice(head, head + 2) == "\xff\xda") {
                segments.push(data.slice(head));
                break;
            } else {
                var length = unpack(">H", data.slice(head + 2, head + 4))[0];
                var endPoint = head + length + 2;
                segments.push(data.slice(head, endPoint));
                head = endPoint;
            }

            if (head >= data.length) {
                throw new Error("Wrong JPEG data.");
            }
        }
        return segments;
    }


    function getExifSeg(segments) {
        var seg;
        for (var i = 0; i < segments.length; i++) {
            seg = segments[i];
            if (seg.slice(0, 2) == "\xff\xe1" &&
                seg.slice(4, 10) == "Exif\x00\x00") {
                return seg;
            }
        }
        return null;
    }


    function mergeSegments(segments, exif) {
        var hasExifSegment = false;
        var additionalAPP1ExifSegments = [];

        segments.forEach(function (segment, i) {
            // Replace first occurence of APP1:Exif segment
            if (segment.slice(0, 2) == "\xff\xe1" &&
                segment.slice(4, 10) == "Exif\x00\x00"
            ) {
                if (!hasExifSegment) {
                    segments[i] = exif;
                    hasExifSegment = true;
                } else {
                    additionalAPP1ExifSegments.unshift(i);
                }
            }
        });

        // Remove additional occurences of APP1:Exif segment
        additionalAPP1ExifSegments.forEach(function (segmentIndex) {
            segments.splice(segmentIndex, 1);
        });

        if (!hasExifSegment && exif) {
            segments = [segments[0], exif].concat(segments.slice(1));
        }

        return segments.join("");
    }


    function toHex(str) {
        var hexStr = "";
        for (var i = 0; i < str.length; i++) {
            var h = str.charCodeAt(i);
            var hex = ((h < 10) ? "0" : "") + h.toString(16);
            hexStr += hex + " ";
        }
        return hexStr;
    }


    var TYPES = {
        "Byte": 1,
        "Ascii": 2,
        "Short": 3,
        "Long": 4,
        "Rational": 5,
        "Undefined": 7,
        "SLong": 9,
        "SRational": 10
    };


    var TAGS = {
        'Image': {
            11: {
                'name': 'ProcessingSoftware',
                'type': 'Ascii'
            },
            254: {
                'name': 'NewSubfileType',
                'type': 'Long'
            },
            255: {
                'name': 'SubfileType',
                'type': 'Short'
            },
            256: {
                'name': 'ImageWidth',
                'type': 'Long'
            },
            257: {
                'name': 'ImageLength',
                'type': 'Long'
            },
            258: {
                'name': 'BitsPerSample',
                'type': 'Short'
            },
            259: {
                'name': 'Compression',
                'type': 'Short'
            },
            262: {
                'name': 'PhotometricInterpretation',
                'type': 'Short'
            },
            263: {
                'name': 'Threshholding',
                'type': 'Short'
            },
            264: {
                'name': 'CellWidth',
                'type': 'Short'
            },
            265: {
                'name': 'CellLength',
                'type': 'Short'
            },
            266: {
                'name': 'FillOrder',
                'type': 'Short'
            },
            269: {
                'name': 'DocumentName',
                'type': 'Ascii'
            },
            270: {
                'name': 'ImageDescription',
                'type': 'Ascii'
            },
            271: {
                'name': 'Make',
                'type': 'Ascii'
            },
            272: {
                'name': 'Model',
                'type': 'Ascii'
            },
            273: {
                'name': 'StripOffsets',
                'type': 'Long'
            },
            274: {
                'name': 'Orientation',
                'type': 'Short'
            },
            277: {
                'name': 'SamplesPerPixel',
                'type': 'Short'
            },
            278: {
                'name': 'RowsPerStrip',
                'type': 'Long'
            },
            279: {
                'name': 'StripByteCounts',
                'type': 'Long'
            },
            282: {
                'name': 'XResolution',
                'type': 'Rational'
            },
            283: {
                'name': 'YResolution',
                'type': 'Rational'
            },
            284: {
                'name': 'PlanarConfiguration',
                'type': 'Short'
            },
            290: {
                'name': 'GrayResponseUnit',
                'type': 'Short'
            },
            291: {
                'name': 'GrayResponseCurve',
                'type': 'Short'
            },
            292: {
                'name': 'T4Options',
                'type': 'Long'
            },
            293: {
                'name': 'T6Options',
                'type': 'Long'
            },
            296: {
                'name': 'ResolutionUnit',
                'type': 'Short'
            },
            301: {
                'name': 'TransferFunction',
                'type': 'Short'
            },
            305: {
                'name': 'Software',
                'type': 'Ascii'
            },
            306: {
                'name': 'DateTime',
                'type': 'Ascii'
            },
            315: {
                'name': 'Artist',
                'type': 'Ascii'
            },
            316: {
                'name': 'HostComputer',
                'type': 'Ascii'
            },
            317: {
                'name': 'Predictor',
                'type': 'Short'
            },
            318: {
                'name': 'WhitePoint',
                'type': 'Rational'
            },
            319: {
                'name': 'PrimaryChromaticities',
                'type': 'Rational'
            },
            320: {
                'name': 'ColorMap',
                'type': 'Short'
            },
            321: {
                'name': 'HalftoneHints',
                'type': 'Short'
            },
            322: {
                'name': 'TileWidth',
                'type': 'Short'
            },
            323: {
                'name': 'TileLength',
                'type': 'Short'
            },
            324: {
                'name': 'TileOffsets',
                'type': 'Short'
            },
            325: {
                'name': 'TileByteCounts',
                'type': 'Short'
            },
            330: {
                'name': 'SubIFDs',
                'type': 'Long'
            },
            332: {
                'name': 'InkSet',
                'type': 'Short'
            },
            333: {
                'name': 'InkNames',
                'type': 'Ascii'
            },
            334: {
                'name': 'NumberOfInks',
                'type': 'Short'
            },
            336: {
                'name': 'DotRange',
                'type': 'Byte'
            },
            337: {
                'name': 'TargetPrinter',
                'type': 'Ascii'
            },
            338: {
                'name': 'ExtraSamples',
                'type': 'Short'
            },
            339: {
                'name': 'SampleFormat',
                'type': 'Short'
            },
            340: {
                'name': 'SMinSampleValue',
                'type': 'Short'
            },
            341: {
                'name': 'SMaxSampleValue',
                'type': 'Short'
            },
            342: {
                'name': 'TransferRange',
                'type': 'Short'
            },
            343: {
                'name': 'ClipPath',
                'type': 'Byte'
            },
            344: {
                'name': 'XClipPathUnits',
                'type': 'Long'
            },
            345: {
                'name': 'YClipPathUnits',
                'type': 'Long'
            },
            346: {
                'name': 'Indexed',
                'type': 'Short'
            },
            347: {
                'name': 'JPEGTables',
                'type': 'Undefined'
            },
            351: {
                'name': 'OPIProxy',
                'type': 'Short'
            },
            512: {
                'name': 'JPEGProc',
                'type': 'Long'
            },
            513: {
                'name': 'JPEGInterchangeFormat',
                'type': 'Long'
            },
            514: {
                'name': 'JPEGInterchangeFormatLength',
                'type': 'Long'
            },
            515: {
                'name': 'JPEGRestartInterval',
                'type': 'Short'
            },
            517: {
                'name': 'JPEGLosslessPredictors',
                'type': 'Short'
            },
            518: {
                'name': 'JPEGPointTransforms',
                'type': 'Short'
            },
            519: {
                'name': 'JPEGQTables',
                'type': 'Long'
            },
            520: {
                'name': 'JPEGDCTables',
                'type': 'Long'
            },
            521: {
                'name': 'JPEGACTables',
                'type': 'Long'
            },
            529: {
                'name': 'YCbCrCoefficients',
                'type': 'Rational'
            },
            530: {
                'name': 'YCbCrSubSampling',
                'type': 'Short'
            },
            531: {
                'name': 'YCbCrPositioning',
                'type': 'Short'
            },
            532: {
                'name': 'ReferenceBlackWhite',
                'type': 'Rational'
            },
            700: {
                'name': 'XMLPacket',
                'type': 'Byte'
            },
            18246: {
                'name': 'Rating',
                'type': 'Short'
            },
            18249: {
                'name': 'RatingPercent',
                'type': 'Short'
            },
            32781: {
                'name': 'ImageID',
                'type': 'Ascii'
            },
            33421: {
                'name': 'CFARepeatPatternDim',
                'type': 'Short'
            },
            33422: {
                'name': 'CFAPattern',
                'type': 'Byte'
            },
            33423: {
                'name': 'BatteryLevel',
                'type': 'Rational'
            },
            33432: {
                'name': 'Copyright',
                'type': 'Ascii'
            },
            33434: {
                'name': 'ExposureTime',
                'type': 'Rational'
            },
            34377: {
                'name': 'ImageResources',
                'type': 'Byte'
            },
            34665: {
                'name': 'ExifTag',
                'type': 'Long'
            },
            34675: {
                'name': 'InterColorProfile',
                'type': 'Undefined'
            },
            34853: {
                'name': 'GPSTag',
                'type': 'Long'
            },
            34857: {
                'name': 'Interlace',
                'type': 'Short'
            },
            34858: {
                'name': 'TimeZoneOffset',
                'type': 'Long'
            },
            34859: {
                'name': 'SelfTimerMode',
                'type': 'Short'
            },
            37387: {
                'name': 'FlashEnergy',
                'type': 'Rational'
            },
            37388: {
                'name': 'SpatialFrequencyResponse',
                'type': 'Undefined'
            },
            37389: {
                'name': 'Noise',
                'type': 'Undefined'
            },
            37390: {
                'name': 'FocalPlaneXResolution',
                'type': 'Rational'
            },
            37391: {
                'name': 'FocalPlaneYResolution',
                'type': 'Rational'
            },
            37392: {
                'name': 'FocalPlaneResolutionUnit',
                'type': 'Short'
            },
            37393: {
                'name': 'ImageNumber',
                'type': 'Long'
            },
            37394: {
                'name': 'SecurityClassification',
                'type': 'Ascii'
            },
            37395: {
                'name': 'ImageHistory',
                'type': 'Ascii'
            },
            37397: {
                'name': 'ExposureIndex',
                'type': 'Rational'
            },
            37398: {
                'name': 'TIFFEPStandardID',
                'type': 'Byte'
            },
            37399: {
                'name': 'SensingMethod',
                'type': 'Short'
            },
            40091: {
                'name': 'XPTitle',
                'type': 'Byte'
            },
            40092: {
                'name': 'XPComment',
                'type': 'Byte'
            },
            40093: {
                'name': 'XPAuthor',
                'type': 'Byte'
            },
            40094: {
                'name': 'XPKeywords',
                'type': 'Byte'
            },
            40095: {
                'name': 'XPSubject',
                'type': 'Byte'
            },
            50341: {
                'name': 'PrintImageMatching',
                'type': 'Undefined'
            },
            50706: {
                'name': 'DNGVersion',
                'type': 'Byte'
            },
            50707: {
                'name': 'DNGBackwardVersion',
                'type': 'Byte'
            },
            50708: {
                'name': 'UniqueCameraModel',
                'type': 'Ascii'
            },
            50709: {
                'name': 'LocalizedCameraModel',
                'type': 'Byte'
            },
            50710: {
                'name': 'CFAPlaneColor',
                'type': 'Byte'
            },
            50711: {
                'name': 'CFALayout',
                'type': 'Short'
            },
            50712: {
                'name': 'LinearizationTable',
                'type': 'Short'
            },
            50713: {
                'name': 'BlackLevelRepeatDim',
                'type': 'Short'
            },
            50714: {
                'name': 'BlackLevel',
                'type': 'Rational'
            },
            50715: {
                'name': 'BlackLevelDeltaH',
                'type': 'SRational'
            },
            50716: {
                'name': 'BlackLevelDeltaV',
                'type': 'SRational'
            },
            50717: {
                'name': 'WhiteLevel',
                'type': 'Short'
            },
            50718: {
                'name': 'DefaultScale',
                'type': 'Rational'
            },
            50719: {
                'name': 'DefaultCropOrigin',
                'type': 'Short'
            },
            50720: {
                'name': 'DefaultCropSize',
                'type': 'Short'
            },
            50721: {
                'name': 'ColorMatrix1',
                'type': 'SRational'
            },
            50722: {
                'name': 'ColorMatrix2',
                'type': 'SRational'
            },
            50723: {
                'name': 'CameraCalibration1',
                'type': 'SRational'
            },
            50724: {
                'name': 'CameraCalibration2',
                'type': 'SRational'
            },
            50725: {
                'name': 'ReductionMatrix1',
                'type': 'SRational'
            },
            50726: {
                'name': 'ReductionMatrix2',
                'type': 'SRational'
            },
            50727: {
                'name': 'AnalogBalance',
                'type': 'Rational'
            },
            50728: {
                'name': 'AsShotNeutral',
                'type': 'Short'
            },
            50729: {
                'name': 'AsShotWhiteXY',
                'type': 'Rational'
            },
            50730: {
                'name': 'BaselineExposure',
                'type': 'SRational'
            },
            50731: {
                'name': 'BaselineNoise',
                'type': 'Rational'
            },
            50732: {
                'name': 'BaselineSharpness',
                'type': 'Rational'
            },
            50733: {
                'name': 'BayerGreenSplit',
                'type': 'Long'
            },
            50734: {
                'name': 'LinearResponseLimit',
                'type': 'Rational'
            },
            50735: {
                'name': 'CameraSerialNumber',
                'type': 'Ascii'
            },
            50736: {
                'name': 'LensInfo',
                'type': 'Rational'
            },
            50737: {
                'name': 'ChromaBlurRadius',
                'type': 'Rational'
            },
            50738: {
                'name': 'AntiAliasStrength',
                'type': 'Rational'
            },
            50739: {
                'name': 'ShadowScale',
                'type': 'SRational'
            },
            50740: {
                'name': 'DNGPrivateData',
                'type': 'Byte'
            },
            50741: {
                'name': 'MakerNoteSafety',
                'type': 'Short'
            },
            50778: {
                'name': 'CalibrationIlluminant1',
                'type': 'Short'
            },
            50779: {
                'name': 'CalibrationIlluminant2',
                'type': 'Short'
            },
            50780: {
                'name': 'BestQualityScale',
                'type': 'Rational'
            },
            50781: {
                'name': 'RawDataUniqueID',
                'type': 'Byte'
            },
            50827: {
                'name': 'OriginalRawFileName',
                'type': 'Byte'
            },
            50828: {
                'name': 'OriginalRawFileData',
                'type': 'Undefined'
            },
            50829: {
                'name': 'ActiveArea',
                'type': 'Short'
            },
            50830: {
                'name': 'MaskedAreas',
                'type': 'Short'
            },
            50831: {
                'name': 'AsShotICCProfile',
                'type': 'Undefined'
            },
            50832: {
                'name': 'AsShotPreProfileMatrix',
                'type': 'SRational'
            },
            50833: {
                'name': 'CurrentICCProfile',
                'type': 'Undefined'
            },
            50834: {
                'name': 'CurrentPreProfileMatrix',
                'type': 'SRational'
            },
            50879: {
                'name': 'ColorimetricReference',
                'type': 'Short'
            },
            50931: {
                'name': 'CameraCalibrationSignature',
                'type': 'Byte'
            },
            50932: {
                'name': 'ProfileCalibrationSignature',
                'type': 'Byte'
            },
            50934: {
                'name': 'AsShotProfileName',
                'type': 'Byte'
            },
            50935: {
                'name': 'NoiseReductionApplied',
                'type': 'Rational'
            },
            50936: {
                'name': 'ProfileName',
                'type': 'Byte'
            },
            50937: {
                'name': 'ProfileHueSatMapDims',
                'type': 'Long'
            },
            50938: {
                'name': 'ProfileHueSatMapData1',
                'type': 'Float'
            },
            50939: {
                'name': 'ProfileHueSatMapData2',
                'type': 'Float'
            },
            50940: {
                'name': 'ProfileToneCurve',
                'type': 'Float'
            },
            50941: {
                'name': 'ProfileEmbedPolicy',
                'type': 'Long'
            },
            50942: {
                'name': 'ProfileCopyright',
                'type': 'Byte'
            },
            50964: {
                'name': 'ForwardMatrix1',
                'type': 'SRational'
            },
            50965: {
                'name': 'ForwardMatrix2',
                'type': 'SRational'
            },
            50966: {
                'name': 'PreviewApplicationName',
                'type': 'Byte'
            },
            50967: {
                'name': 'PreviewApplicationVersion',
                'type': 'Byte'
            },
            50968: {
                'name': 'PreviewSettingsName',
                'type': 'Byte'
            },
            50969: {
                'name': 'PreviewSettingsDigest',
                'type': 'Byte'
            },
            50970: {
                'name': 'PreviewColorSpace',
                'type': 'Long'
            },
            50971: {
                'name': 'PreviewDateTime',
                'type': 'Ascii'
            },
            50972: {
                'name': 'RawImageDigest',
                'type': 'Undefined'
            },
            50973: {
                'name': 'OriginalRawFileDigest',
                'type': 'Undefined'
            },
            50974: {
                'name': 'SubTileBlockSize',
                'type': 'Long'
            },
            50975: {
                'name': 'RowInterleaveFactor',
                'type': 'Long'
            },
            50981: {
                'name': 'ProfileLookTableDims',
                'type': 'Long'
            },
            50982: {
                'name': 'ProfileLookTableData',
                'type': 'Float'
            },
            51008: {
                'name': 'OpcodeList1',
                'type': 'Undefined'
            },
            51009: {
                'name': 'OpcodeList2',
                'type': 'Undefined'
            },
            51022: {
                'name': 'OpcodeList3',
                'type': 'Undefined'
            }
        },
        'Exif': {
            33434: {
                'name': 'ExposureTime',
                'type': 'Rational'
            },
            33437: {
                'name': 'FNumber',
                'type': 'Rational'
            },
            34850: {
                'name': 'ExposureProgram',
                'type': 'Short'
            },
            34852: {
                'name': 'SpectralSensitivity',
                'type': 'Ascii'
            },
            34855: {
                'name': 'ISOSpeedRatings',
                'type': 'Short'
            },
            34856: {
                'name': 'OECF',
                'type': 'Undefined'
            },
            34864: {
                'name': 'SensitivityType',
                'type': 'Short'
            },
            34865: {
                'name': 'StandardOutputSensitivity',
                'type': 'Long'
            },
            34866: {
                'name': 'RecommendedExposureIndex',
                'type': 'Long'
            },
            34867: {
                'name': 'ISOSpeed',
                'type': 'Long'
            },
            34868: {
                'name': 'ISOSpeedLatitudeyyy',
                'type': 'Long'
            },
            34869: {
                'name': 'ISOSpeedLatitudezzz',
                'type': 'Long'
            },
            36864: {
                'name': 'ExifVersion',
                'type': 'Undefined'
            },
            36867: {
                'name': 'DateTimeOriginal',
                'type': 'Ascii'
            },
            36868: {
                'name': 'DateTimeDigitized',
                'type': 'Ascii'
            },
            37121: {
                'name': 'ComponentsConfiguration',
                'type': 'Undefined'
            },
            37122: {
                'name': 'CompressedBitsPerPixel',
                'type': 'Rational'
            },
            37377: {
                'name': 'ShutterSpeedValue',
                'type': 'SRational'
            },
            37378: {
                'name': 'ApertureValue',
                'type': 'Rational'
            },
            37379: {
                'name': 'BrightnessValue',
                'type': 'SRational'
            },
            37380: {
                'name': 'ExposureBiasValue',
                'type': 'SRational'
            },
            37381: {
                'name': 'MaxApertureValue',
                'type': 'Rational'
            },
            37382: {
                'name': 'SubjectDistance',
                'type': 'Rational'
            },
            37383: {
                'name': 'MeteringMode',
                'type': 'Short'
            },
            37384: {
                'name': 'LightSource',
                'type': 'Short'
            },
            37385: {
                'name': 'Flash',
                'type': 'Short'
            },
            37386: {
                'name': 'FocalLength',
                'type': 'Rational'
            },
            37396: {
                'name': 'SubjectArea',
                'type': 'Short'
            },
            37500: {
                'name': 'MakerNote',
                'type': 'Undefined'
            },
            37510: {
                'name': 'UserComment',
                'type': 'Undefined' // Changed from Ascii to Undefined
            },
            37520: {
                'name': 'SubSecTime',
                'type': 'Ascii'
            },
            37521: {
                'name': 'SubSecTimeOriginal',
                'type': 'Ascii'
            },
            37522: {
                'name': 'SubSecTimeDigitized',
                'type': 'Ascii'
            },
            40960: {
                'name': 'FlashpixVersion',
                'type': 'Undefined'
            },
            40961: {
                'name': 'ColorSpace',
                'type': 'Short'
            },
            40962: {
                'name': 'PixelXDimension',
                'type': 'Long'
            },
            40963: {
                'name': 'PixelYDimension',
                'type': 'Long'
            },
            40964: {
                'name': 'RelatedSoundFile',
                'type': 'Ascii'
            },
            40965: {
                'name': 'InteroperabilityTag',
                'type': 'Long'
            },
            41483: {
                'name': 'FlashEnergy',
                'type': 'Rational'
            },
            41484: {
                'name': 'SpatialFrequencyResponse',
                'type': 'Undefined'
            },
            41486: {
                'name': 'FocalPlaneXResolution',
                'type': 'Rational'
            },
            41487: {
                'name': 'FocalPlaneYResolution',
                'type': 'Rational'
            },
            41488: {
                'name': 'FocalPlaneResolutionUnit',
                'type': 'Short'
            },
            41492: {
                'name': 'SubjectLocation',
                'type': 'Short'
            },
            41493: {
                'name': 'ExposureIndex',
                'type': 'Rational'
            },
            41495: {
                'name': 'SensingMethod',
                'type': 'Short'
            },
            41728: {
                'name': 'FileSource',
                'type': 'Undefined'
            },
            41729: {
                'name': 'SceneType',
                'type': 'Undefined'
            },
            41730: {
                'name': 'CFAPattern',
                'type': 'Undefined'
            },
            41985: {
                'name': 'CustomRendered',
                'type': 'Short'
            },
            41986: {
                'name': 'ExposureMode',
                'type': 'Short'
            },
            41987: {
                'name': 'WhiteBalance',
                'type': 'Short'
            },
            41988: {
                'name': 'DigitalZoomRatio',
                'type': 'Rational'
            },
            41989: {
                'name': 'FocalLengthIn35mmFilm',
                'type': 'Short'
            },
            41990: {
                'name': 'SceneCaptureType',
                'type': 'Short'
            },
            41991: {
                'name': 'GainControl',
                'type': 'Short'
            },
            41992: {
                'name': 'Contrast',
                'type': 'Short'
            },
            41993: {
                'name': 'Saturation',
                'type': 'Short'
            },
            41994: {
                'name': 'Sharpness',
                'type': 'Short'
            },
            41995: {
                'name': 'DeviceSettingDescription',
                'type': 'Undefined'
            },
            41996: {
                'name': 'SubjectDistanceRange',
                'type': 'Short'
            },
            42016: {
                'name': 'ImageUniqueID',
                'type': 'Ascii'
            },
            42032: {
                'name': 'CameraOwnerName',
                'type': 'Ascii'
            },
            42033: {
                'name': 'BodySerialNumber',
                'type': 'Ascii'
            },
            42034: {
                'name': 'LensSpecification',
                'type': 'Rational'
            },
            42035: {
                'name': 'LensMake',
                'type': 'Ascii'
            },
            42036: {
                'name': 'LensModel',
                'type': 'Ascii'
            },
            42037: {
                'name': 'LensSerialNumber',
                'type': 'Ascii'
            },
            42240: {
                'name': 'Gamma',
                'type': 'Rational'
            }
        },
        'GPS': {
            0: {
                'name': 'GPSVersionID',
                'type': 'Byte'
            },
            1: {
                'name': 'GPSLatitudeRef',
                'type': 'Ascii'
            },
            2: {
                'name': 'GPSLatitude',
                'type': 'Rational'
            },
            3: {
                'name': 'GPSLongitudeRef',
                'type': 'Ascii'
            },
            4: {
                'name': 'GPSLongitude',
                'type': 'Rational'
            },
            5: {
                'name': 'GPSAltitudeRef',
                'type': 'Byte'
            },
            6: {
                'name': 'GPSAltitude',
                'type': 'Rational'
            },
            7: {
                'name': 'GPSTimeStamp',
                'type': 'Rational'
            },
            8: {
                'name': 'GPSSatellites',
                'type': 'Ascii'
            },
            9: {
                'name': 'GPSStatus',
                'type': 'Ascii'
            },
            10: {
                'name': 'GPSMeasureMode',
                'type': 'Ascii'
            },
            11: {
                'name': 'GPSDOP',
                'type': 'Rational'
            },
            12: {
                'name': 'GPSSpeedRef',
                'type': 'Ascii'
            },
            13: {
                'name': 'GPSSpeed',
                'type': 'Rational'
            },
            14: {
                'name': 'GPSTrackRef',
                'type': 'Ascii'
            },
            15: {
                'name': 'GPSTrack',
                'type': 'Rational'
            },
            16: {
                'name': 'GPSImgDirectionRef',
                'type': 'Ascii'
            },
            17: {
                'name': 'GPSImgDirection',
                'type': 'Rational'
            },
            18: {
                'name': 'GPSMapDatum',
                'type': 'Ascii'
            },
            19: {
                'name': 'GPSDestLatitudeRef',
                'type': 'Ascii'
            },
            20: {
                'name': 'GPSDestLatitude',
                'type': 'Rational'
            },
            21: {
                'name': 'GPSDestLongitudeRef',
                'type': 'Ascii'
            },
            22: {
                'name': 'GPSDestLongitude',
                'type': 'Rational'
            },
            23: {
                'name': 'GPSDestBearingRef',
                'type': 'Ascii'
            },
            24: {
                'name': 'GPSDestBearing',
                'type': 'Rational'
            },
            25: {
                'name': 'GPSDestDistanceRef',
                'type': 'Ascii'
            },
            26: {
                'name': 'GPSDestDistance',
                'type': 'Rational'
            },
            27: {
                'name': 'GPSProcessingMethod',
                'type': 'Undefined'
            },
            28: {
                'name': 'GPSAreaInformation',
                'type': 'Undefined'
            },
            29: {
                'name': 'GPSDateStamp',
                'type': 'Ascii'
            },
            30: {
                'name': 'GPSDifferential',
                'type': 'Short'
            },
            31: {
                'name': 'GPSHPositioningError',
                'type': 'Rational'
            }
        },
        'Interop': {
            1: {
                'name': 'InteroperabilityIndex',
                'type': 'Ascii'
            }
        },
    };
    TAGS["0th"] = TAGS["Image"];
    TAGS["1st"] = TAGS["Image"];
    that.TAGS = TAGS;


    that.ImageIFD = {
        ProcessingSoftware: 11,
        NewSubfileType: 254,
        SubfileType: 255,
        ImageWidth: 256,
        ImageLength: 257,
        BitsPerSample: 258,
        Compression: 259,
        PhotometricInterpretation: 262,
        Threshholding: 263,
        CellWidth: 264,
        CellLength: 265,
        FillOrder: 266,
        DocumentName: 269,
        ImageDescription: 270,
        Make: 271,
        Model: 272,
        StripOffsets: 273,
        Orientation: 274,
        SamplesPerPixel: 277,
        RowsPerStrip: 278,
        StripByteCounts: 279,
        XResolution: 282,
        YResolution: 283,
        PlanarConfiguration: 284,
        GrayResponseUnit: 290,
        GrayResponseCurve: 291,
        T4Options: 292,
        T6Options: 293,
        ResolutionUnit: 296,
        TransferFunction: 301,
        Software: 305,
        DateTime: 306,
        Artist: 315,
        HostComputer: 316,
        Predictor: 317,
        WhitePoint: 318,
        PrimaryChromaticities: 319,
        ColorMap: 320,
        HalftoneHints: 321,
        TileWidth: 322,
        TileLength: 323,
        TileOffsets: 324,
        TileByteCounts: 325,
        SubIFDs: 330,
        InkSet: 332,
        InkNames: 333,
        NumberOfInks: 334,
        DotRange: 336,
        TargetPrinter: 337,
        ExtraSamples: 338,
        SampleFormat: 339,
        SMinSampleValue: 340,
        SMaxSampleValue: 341,
        TransferRange: 342,
        ClipPath: 343,
        XClipPathUnits: 344,
        YClipPathUnits: 345,
        Indexed: 346,
        JPEGTables: 347,
        OPIProxy: 351,
        JPEGProc: 512,
        JPEGInterchangeFormat: 513,
        JPEGInterchangeFormatLength: 514,
        JPEGRestartInterval: 515,
        JPEGLosslessPredictors: 517,
        JPEGPointTransforms: 518,
        JPEGQTables: 519,
        JPEGDCTables: 520,
        JPEGACTables: 521,
        YCbCrCoefficients: 529,
        YCbCrSubSampling: 530,
        YCbCrPositioning: 531,
        ReferenceBlackWhite: 532,
        XMLPacket: 700,
        Rating: 18246,
        RatingPercent: 18249,
        ImageID: 32781,
        CFARepeatPatternDim: 33421,
        CFAPattern: 33422,
        BatteryLevel: 33423,
        Copyright: 33432,
        ExposureTime: 33434,
        ImageResources: 34377,
        ExifTag: 34665,
        InterColorProfile: 34675,
        GPSTag: 34853,
        Interlace: 34857,
        TimeZoneOffset: 34858,
        SelfTimerMode: 34859,
        FlashEnergy: 37387,
        SpatialFrequencyResponse: 37388,
        Noise: 37389,
        FocalPlaneXResolution: 37390,
        FocalPlaneYResolution: 37391,
        FocalPlaneResolutionUnit: 37392,
        ImageNumber: 37393,
        SecurityClassification: 37394,
        ImageHistory: 37395,
        ExposureIndex: 37397,
        TIFFEPStandardID: 37398,
        SensingMethod: 37399,
        XPTitle: 40091,
        XPComment: 40092,
        XPAuthor: 40093,
        XPKeywords: 40094,
        XPSubject: 40095,
        PrintImageMatching: 50341,
        DNGVersion: 50706,
        DNGBackwardVersion: 50707,
        UniqueCameraModel: 50708,
        LocalizedCameraModel: 50709,
        CFAPlaneColor: 50710,
        CFALayout: 50711,
        LinearizationTable: 50712,
        BlackLevelRepeatDim: 50713,
        BlackLevel: 50714,
        BlackLevelDeltaH: 50715,
        BlackLevelDeltaV: 50716,
        WhiteLevel: 50717,
        DefaultScale: 50718,
        DefaultCropOrigin: 50719,
        DefaultCropSize: 50720,
        ColorMatrix1: 50721,
        ColorMatrix2: 50722,
        CameraCalibration1: 50723,
        CameraCalibration2: 50724,
        ReductionMatrix1: 50725,
        ReductionMatrix2: 50726,
        AnalogBalance: 50727,
        AsShotNeutral: 50728,
        AsShotWhiteXY: 50729,
        BaselineExposure: 50730,
        BaselineNoise: 50731,
        BaselineSharpness: 50732,
        BayerGreenSplit: 50733,
        LinearResponseLimit: 50734,
        CameraSerialNumber: 50735,
        LensInfo: 50736,
        ChromaBlurRadius: 50737,
        AntiAliasStrength: 50738,
        ShadowScale: 50739,
        DNGPrivateData: 50740,
        MakerNoteSafety: 50741,
        CalibrationIlluminant1: 50778,
        CalibrationIlluminant2: 50779,
        BestQualityScale: 50780,
        RawDataUniqueID: 50781,
        OriginalRawFileName: 50827,
        OriginalRawFileData: 50828,
        ActiveArea: 50829,
        MaskedAreas: 50830,
        AsShotICCProfile: 50831,
        AsShotPreProfileMatrix: 50832,
        CurrentICCProfile: 50833,
        CurrentPreProfileMatrix: 50834,
        ColorimetricReference: 50879,
        CameraCalibrationSignature: 50931,
        ProfileCalibrationSignature: 50932,
        AsShotProfileName: 50934,
        NoiseReductionApplied: 50935,
        ProfileName: 50936,
        ProfileHueSatMapDims: 50937,
        ProfileHueSatMapData1: 50938,
        ProfileHueSatMapData2: 50939,
        ProfileToneCurve: 50940,
        ProfileEmbedPolicy: 50941,
        ProfileCopyright: 50942,
        ForwardMatrix1: 50964,
        ForwardMatrix2: 50965,
        PreviewApplicationName: 50966,
        PreviewApplicationVersion: 50967,
        PreviewSettingsName: 50968,
        PreviewSettingsDigest: 50969,
        PreviewColorSpace: 50970,
        PreviewDateTime: 50971,
        RawImageDigest: 50972,
        OriginalRawFileDigest: 50973,
        SubTileBlockSize: 50974,
        RowInterleaveFactor: 50975,
        ProfileLookTableDims: 50981,
        ProfileLookTableData: 50982,
        OpcodeList1: 51008,
        OpcodeList2: 51009,
        OpcodeList3: 51022,
        NoiseProfile: 51041,
    };


    that.ExifIFD = {
        ExposureTime: 33434,
        FNumber: 33437,
        ExposureProgram: 34850,
        SpectralSensitivity: 34852,
        ISOSpeedRatings: 34855,
        OECF: 34856,
        SensitivityType: 34864,
        StandardOutputSensitivity: 34865,
        RecommendedExposureIndex: 34866,
        ISOSpeed: 34867,
        ISOSpeedLatitudeyyy: 34868,
        ISOSpeedLatitudezzz: 34869,
        ExifVersion: 36864,
        DateTimeOriginal: 36867,
        DateTimeDigitized: 36868,
        ComponentsConfiguration: 37121,
        CompressedBitsPerPixel: 37122,
        ShutterSpeedValue: 37377,
        ApertureValue: 37378,
        BrightnessValue: 37379,
        ExposureBiasValue: 37380,
        MaxApertureValue: 37381,
        SubjectDistance: 37382,
        MeteringMode: 37383,
        LightSource: 37384,
        Flash: 37385,
        FocalLength: 37386,
        SubjectArea: 37396,
        MakerNote: 37500,
        UserComment: 37510,
        SubSecTime: 37520,
        SubSecTimeOriginal: 37521,
        SubSecTimeDigitized: 37522,
        FlashpixVersion: 40960,
        ColorSpace: 40961,
        PixelXDimension: 40962,
        PixelYDimension: 40963,
        RelatedSoundFile: 40964,
        InteroperabilityTag: 40965,
        FlashEnergy: 41483,
        SpatialFrequencyResponse: 41484,
        FocalPlaneXResolution: 41486,
        FocalPlaneYResolution: 41487,
        FocalPlaneResolutionUnit: 41488,
        SubjectLocation: 41492,
        ExposureIndex: 41493,
        SensingMethod: 41495,
        FileSource: 41728,
        SceneType: 41729,
        CFAPattern: 41730,
        CustomRendered: 41985,
        ExposureMode: 41986,
        WhiteBalance: 41987,
        DigitalZoomRatio: 41988,
        FocalLengthIn35mmFilm: 41989,
        SceneCaptureType: 41990,
        GainControl: 41991,
        Contrast: 41992,
        Saturation: 41993,
        Sharpness: 41994,
        DeviceSettingDescription: 41995,
        SubjectDistanceRange: 41996,
        ImageUniqueID: 42016,
        CameraOwnerName: 42032,
        BodySerialNumber: 42033,
        LensSpecification: 42034,
        LensMake: 42035,
        LensModel: 42036,
        LensSerialNumber: 42037,
        Gamma: 42240,
    };


    that.GPSIFD = {
        GPSVersionID: 0,
        GPSLatitudeRef: 1,
        GPSLatitude: 2,
        GPSLongitudeRef: 3,
        GPSLongitude: 4,
        GPSAltitudeRef: 5,
        GPSAltitude: 6,
        GPSTimeStamp: 7,
        GPSSatellites: 8,
        GPSStatus: 9,
        GPSMeasureMode: 10,
        GPSDOP: 11,
        GPSSpeedRef: 12,
        GPSSpeed: 13,
        GPSTrackRef: 14,
        GPSTrack: 15,
        GPSImgDirectionRef: 16,
        GPSImgDirection: 17,
        GPSMapDatum: 18,
        GPSDestLatitudeRef: 19,
        GPSDestLatitude: 20,
        GPSDestLongitudeRef: 21,
        GPSDestLongitude: 22,
        GPSDestBearingRef: 23,
        GPSDestBearing: 24,
        GPSDestDistanceRef: 25,
        GPSDestDistance: 26,
        GPSProcessingMethod: 27,
        GPSAreaInformation: 28,
        GPSDateStamp: 29,
        GPSDifferential: 30,
        GPSHPositioningError: 31,
    };


    that.InteropIFD = {
        InteroperabilityIndex: 1,
    };

    that.GPSHelper = {
        degToDmsRational: function (degFloat) {
            var degAbs = Math.abs(degFloat);
            var minFloat = degAbs % 1 * 60;
            var secFloat = minFloat % 1 * 60;
            var deg = Math.floor(degAbs);
            var min = Math.floor(minFloat);
            var sec = Math.round(secFloat * 100);

            return [[deg, 1], [min, 1], [sec, 100]];
        },

        dmsRationalToDeg: function (dmsArray, ref) {
            var sign = (ref === 'S' || ref === 'W') ? -1.0 : 1.0;
            var deg = dmsArray[0][0] / dmsArray[0][1] +
                dmsArray[1][0] / dmsArray[1][1] / 60.0 +
                dmsArray[2][0] / dmsArray[2][1] / 3600.0;

            return deg * sign;
        }
    };


    if (typeof exports !== 'undefined') {
        if (typeof module !== 'undefined' && module.exports) {
            exports = module.exports = that;
        }
        exports.piexif = that;
    } else {
        window.piexif = that;
    }
})();
// End of piexifjs

// Start of QuickEXIF script
(function () {
    'use strict';

    // Constants
    const JPEG_EXTENSIONS = ['jpg', 'jpeg'];
    const MAX_COORDINATE_VALUE = 180;
    const MAX_EDIT_SUMMARY_LENGTH = 500;
    const SUCCESS_RELOAD_DELAY = 2000;
    const EXIF_DATE_FORMAT = /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/;
    const USERCOMMENT_CHARSET_PREFIX = 'ASCII\x00\x00\x00';
    const GPS_VERSION = [2, 2, 0, 0];
    const GPS_MAP_DATUM = 'WGS-84';

    // Regex patterns and maps
    const RE_GPS_DECIMAL = /^([+-]?\d+\.?\d*)°?$/;
    const RE_GPS_DMS = /(\d+(?:\.\d+)?)°\s*(\d+(?:\.\d+)?)['''′]\s*([\d.]+)["″""]?\s*([NSEW])?/i;
    const RE_GPS_DECIMAL_DIR = /([\d.]+)\s*([NSEW])/i;
    const RE_WM_DATE = /(\d{1,2}):(\d{2}),\s+(\d{1,2})\s+(\w+)\s+(\d{4})/;
    const RE_ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

    const MONTHS_MAP = {
        'January': '01', 'February': '02', 'March': '03', 'April': '04',
        'May': '05', 'June': '06', 'July': '07', 'August': '08',
        'September': '09', 'October': '10', 'November': '11', 'December': '12'
    };

    const FIELD_NAME_MAP = {
        'datetimeoriginal': 'DateTimeOriginal',
        'imagedescription': 'ImageDescription',
        'artist': 'Artist',
        'copyright': 'Copyright',
        'usercomment': 'UserComment',
        'gpslatitude': 'GPSLatitude',
        'gpslongitude': 'GPSLongitude'
    };

    let editMode = false;
    let currentFileName = null;
    let api = null;
    let metadataTable = null;

    /**
     * Initialize the EXIF editor.
     */
    function init() {
        try {
            if (typeof mw === 'undefined' || !mw.Api) {
                return;
            }

            api = new mw.Api();

            metadataTable = document.getElementById('mw_metadata');
            if (!metadataTable) {
                return;
            }

            currentFileName = getFileName();
            if (!currentFileName) {
                return;
            }

            // Only run on JPEG files
            if (!isJPEGFile(currentFileName)) {
                return;
            }

            // Only show "Edit" button if user can upload
            canUserReupload().then(canReupload => {
                if (canReupload) {
                    injectEditButton(metadataTable);
                } else {
                    showUnavailableMessage(metadataTable);
                }
            }).catch(error => {
                console.error('[QuickEXIF] Error checking upload permissions:', error);
                // Show button anyway as fallback
                injectEditButton(metadataTable);
            });
        } catch (error) {
            console.error('[QuickEXIF] Error initializing:', error);
        }
    }

    /**
     * Show a message indicating QuickEXIF is unavailable due to permissions.
     * @param {HTMLElement} metadataTable - The metadata table element.
     */
    function showUnavailableMessage(metadataTable) {
        const messageContainer = document.createElement('div');
        messageContainer.style.cssText = 'width: fit-content; margin: 0 0 10px 0; padding: 10px; background: #f0f0f0; color: #666; border: 1px solid #ccc; border-radius: 3px; font-size: 14px;';
        messageContainer.textContent = 'QuickEXIF unavailable, can\'t overwrite file';

        metadataTable.parentNode.insertBefore(messageContainer, metadataTable);
    }

    /**
     * Check if user has permission to reupload the file.
     * @returns {Promise<boolean>} Promise that resolves to true if the user can reupload, false otherwise.
     */
    async function canUserReupload() {
        // Get current user
        const currentUser = mw.config.get('wgUserName');

        // Anonymous users cannot upload
        if (!currentUser) {
            return false;
        }

        // Get user groups
        const userGroups = mw.config.get('wgUserGroups') || [];

        // Sysops, autoconfirmed, and confirmed users can upload other users' files
        if (userGroups.includes('sysop') ||
            userGroups.includes('autoconfirmed') ||
            userGroups.includes('confirmed')) {
            return checkFileProtection();
        }

        // Other regular users can only reupload their own files
        if (userGroups.includes('user')) {
            try {
                const isOwner = await isOriginalUploader(currentUser);
                if (isOwner) {
                    return checkFileProtection();
                }
            } catch (error) {
                console.error('[QuickEXIF] Error checking file ownership:', error);
                return false;
            }
        }

        return false;
    }

    /**
     * Check if the current user is the original uploader of the file.
     * @param {string} currentUser - The current user's username.
     * @returns {Promise<boolean>} Promise that resolves to true if user is original uploader.
     */
    async function isOriginalUploader(currentUser) {
        try {
            const result = await api.get({
                action: 'query',
                prop: 'imageinfo',
                titles: 'File:' + currentFileName,
                iiprop: 'user',
                iilimit: 1
            });

            const pages = result.query.pages;
            const page = pages[Object.keys(pages)[0]];

            if (page.imageinfo && page.imageinfo[0]) {
                return page.imageinfo[0].user === currentUser;
            }
        } catch (error) {
            console.error('[QuickEXIF] Error in isOriginalUploader:', error);
            throw error;
        }

        return false;
    }

    /**
     * Check if the file page has upload protection that the user cannot bypass.
     * @returns {boolean} True if user can upload despite protection.
     */
    function checkFileProtection() {
        // Get upload restrictions from page
        const uploadRestrictions = mw.config.get('wgRestrictionUpload') || [];
        if (uploadRestrictions.length === 0) {
            return true;
        }

        const userGroups = mw.config.get('wgUserGroups') || [];

        // Assume sysops always allowed
        if (userGroups.includes('sysop')) {
            return true;
        }

        // Check if user meets each restriction level
        for (const restrictionLevel of uploadRestrictions) {
            if (restrictionLevel === 'autoconfirmed') {
                if (!userGroups.includes('autoconfirmed') && !userGroups.includes('confirmed')) {
                    return false;
                }
            } else if (!userGroups.includes(restrictionLevel)) {
                return false;
            }
        }

        return true;
    }

    /**
     * Check if a file is a JPEG based on its extension.
     * @param {string} filename - The filename to check.
     * @returns {boolean} True if the file is a JPEG, false otherwise.
     */
    function isJPEGFile(filename) {
        if (!filename || typeof filename !== 'string') {
            return false;
        }
        const extension = filename.split('.').pop().toLowerCase();
        return JPEG_EXTENSIONS.includes(extension);
    }

    /**
     * Extract the file name from the current page.
     * @returns {string|null} The file name without 'File:' prefix, or null if not found.
     */
    function getFileName() {
        const pageTitle = mw.config.get('wgPageName');
        if (pageTitle && pageTitle.startsWith('File:')) {
            // Remove 'File:' prefix and return just the filename
            return pageTitle.substring(5);
        }
        return null;
    }

    /**
     * Inject missing editable EXIF fields into the metadata table.
     * Fields that don't exist in the original EXIF data will be added as editable placeholders.
     * @param {HTMLElement} metadataTable - The metadata table element.
     */
    function injectMissingFields(metadataTable) {
        const tbody = metadataTable.querySelector('tbody');
        if (!tbody) return;

        const missingFields = [];
        EDITABLE_FIELDS.forEach(field => {
            const existingRow = metadataTable.querySelector('.' + field.className);
            if (!existingRow) {
                missingFields.push(field);
            }
        });

        if (missingFields.length === 0) return;

        // Create "Existing EXIF Fields" header
        let existingHeader = metadataTable.querySelector('.exif-existing-fields-header');
        if (!existingHeader) {
            let insertionPoint = tbody.firstChild;
            while (insertionPoint && (insertionPoint.classList.contains('exif-new-fields-header') || (insertionPoint.dataset && insertionPoint.dataset.injected === 'true'))) {
                insertionPoint = insertionPoint.nextSibling;
            }

            if (insertionPoint) {
                existingHeader = document.createElement('tr');
                existingHeader.className = 'exif-existing-fields-header';
                const th = document.createElement('th');
                th.textContent = 'Existing EXIF Fields';
                th.colSpan = 2;
                th.style.cssText = 'text-align: center; background-color: #f8f9fa; color: #202122; padding: 10px; border-bottom: 2px solid #a2a9b1; border-top: 2px solid #a2a9b1;';
                existingHeader.appendChild(th);
                tbody.insertBefore(existingHeader, insertionPoint);
            }
        }

        // Create "New EXIF Fields" header
        let headerRow = metadataTable.querySelector('.exif-new-fields-header');
        if (!headerRow) {
            headerRow = document.createElement('tr');
            headerRow.className = 'exif-new-fields-header';
            const th = document.createElement('th');
            th.textContent = 'New EXIF Fields';
            th.colSpan = 2;
            th.style.cssText = 'text-align: center; background-color: #f8f9fa; color: #202122; padding: 10px; border-bottom: 2px solid #a2a9b1;';
            headerRow.appendChild(th);
            tbody.insertBefore(headerRow, tbody.firstChild);
        }

        // Insert new fields after the "new fields" header
        let lastNode = headerRow;
        let tempNode = headerRow;
        while (tempNode.nextSibling && tempNode.nextSibling.dataset && tempNode.nextSibling.dataset.injected === 'true') {
            tempNode = tempNode.nextSibling;
        }
        lastNode = tempNode;

        missingFields.forEach(field => {
            if (metadataTable.querySelector('.' + field.className)) return;

            // Create new row for the missing field
            const tr = document.createElement('tr');
            tr.className = field.className;
            tr.dataset.injected = 'true';

            const th = document.createElement('th');
            th.textContent = field.label;
            th.title = 'This field was not in the original EXIF data';

            const td = document.createElement('td');
            td.textContent = field.defaultValue;
            td.style.fontStyle = 'italic';
            td.style.color = '#999';

            tr.appendChild(th);
            tr.appendChild(td);

            // Insert after lastNode
            if (lastNode.nextSibling) {
                tbody.insertBefore(tr, lastNode.nextSibling);
            } else {
                tbody.appendChild(tr);
            }
            lastNode = tr;
        });
    }

    /**
     * Inject the Edit EXIF button into the page.
     * @param {HTMLElement} metadataTable - The metadata table element.
     */
    function injectEditButton(metadataTable) {
        const buttonContainer = document.createElement('div');
        buttonContainer.id = 'exif-editor-controls';
        buttonContainer.style.cssText = 'margin: 0 0 10px 0;';

        const editButton = document.createElement('button');
        editButton.textContent = 'Edit EXIF';
        editButton.style.cssText = 'padding: 8px 16px; background: #36c; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 14px; margin-right: 10px;';
        editButton.addEventListener('click', toggleEditMode);

        buttonContainer.appendChild(editButton);
        metadataTable.parentNode.insertBefore(buttonContainer, metadataTable);
    }

    /**
     * Toggle between view and edit modes.
     */
    function toggleEditMode() {
        editMode = !editMode;

        if (editMode) {
            enterEditMode();
        } else {
            exitEditMode();
        }
    }

    /**
     * Configuration for editable EXIF fields.
     */
    const EDITABLE_FIELDS = [
        {
            className: 'exif-datetimeoriginal',
            label: 'Date and time of data generation',
            fieldName: 'datetimeoriginal',
            inputType: 'datetime-local',
            defaultValue: '',
            createInput: (currentValue) => {
                const input = document.createElement('input');
                input.type = 'datetime-local';
                input.step = '1';
                input.style.cssText = 'width: 95%; padding: 4px; font-size: 14px;';
                input.dataset.fieldName = 'datetimeoriginal';
                input.required = false;
                const parsedDate = parseWikimediaDate(currentValue);
                if (parsedDate) {
                    input.value = parsedDate;
                }
                return input;
            }
        },
        {
            className: 'exif-imagedescription',
            label: 'Image description',
            fieldName: 'imagedescription',
            inputType: 'text',
            multiline: true,
            defaultValue: '',
            placeholder: 'Brief description of the image'
        },
        {
            className: 'exif-artist',
            label: 'Photographer',
            fieldName: 'artist',
            inputType: 'text',
            multiline: true,
            defaultValue: '',
            placeholder: 'Author/Artist name'
        },
        {
            className: 'exif-copyright',
            label: 'Copyright holder',
            fieldName: 'copyright',
            inputType: 'text',
            multiline: true,
            defaultValue: '',
            placeholder: 'Copyright holder'
        },
        {
            className: 'exif-usercomment',
            label: 'User comment',
            fieldName: 'usercomment',
            inputType: 'text',
            multiline: true,
            defaultValue: '',
            placeholder: 'Additional notes or comments'
        },
        {
            className: 'exif-gpslatitude',
            label: 'GPS Latitude',
            fieldName: 'gpslatitude',
            inputType: 'number',
            defaultValue: '(not set)',
            createInput: (currentValue) => {
                const parsedCoord = parseGPSCoordinate(currentValue);
                const input = document.createElement('input');
                input.type = 'number';
                input.step = 'any';
                input.min = '-90';
                input.max = '90';
                input.style.cssText = 'width: 95%; padding: 4px; font-size: 14px;';
                input.value = parsedCoord !== null ? parsedCoord : '';
                input.dataset.fieldName = 'gpslatitude';
                input.placeholder = 'e.g., 37.7749 (positive for N, negative for S)';
                return input;
            }
        },
        {
            className: 'exif-gpslongitude',
            label: 'GPS Longitude',
            fieldName: 'gpslongitude',
            inputType: 'number',
            defaultValue: '(not set)',
            createInput: (currentValue) => {
                const parsedCoord = parseGPSCoordinate(currentValue);
                const input = document.createElement('input');
                input.type = 'number';
                input.step = 'any';
                input.min = String(-MAX_COORDINATE_VALUE);
                input.max = String(MAX_COORDINATE_VALUE);
                input.style.cssText = 'width: 95%; padding: 4px; font-size: 14px;';
                input.value = parsedCoord !== null ? parsedCoord : '';
                input.dataset.fieldName = 'gpslongitude';
                input.placeholder = 'e.g., -122.4194 (positive for E, negative for W)';
                return input;
            }
        }
    ];

    /**
     * Create an input element for a field.
     * @param {Object} fieldConfig - Field configuration object.
     * @param {string} currentValue - Current field value.
     * @returns {HTMLInputElement} The created input element.
     */
    function createFieldInput(fieldConfig, currentValue) {
        let input;
        if (fieldConfig.createInput) {
            input = fieldConfig.createInput(currentValue);
        } else {
            if (fieldConfig.multiline) {
                input = document.createElement('textarea');
                input.rows = 2;
                input.style.resize = 'vertical';
            } else {
                input = document.createElement('input');
                input.type = fieldConfig.inputType || 'text';
            }

            input.style.cssText += 'width: 95%; padding: 4px; font-size: 14px; font-family: sans-serif;';
            if (fieldConfig.multiline) {
                input.style.minHeight = '60px';
            }

            input.value = currentValue;
            input.dataset.fieldName = fieldConfig.fieldName;
            if (fieldConfig.placeholder) {
                input.placeholder = fieldConfig.placeholder;
            }
        }

        // Store for restoration (the original display text)
        input.dataset.originalText = currentValue;

        // Store for change detection (the initial input state)
        input.dataset.initialValue = input.value || '';

        return input;
    }

    /**
     * Restore a field to its original text value.
     * @param {HTMLElement} row - The table row element.
     */
    function restoreField(row) {
        if (!row) return;
        const tdElement = row.querySelector('td');
        if (!tdElement) return;
        const input = tdElement.querySelector('input, textarea');
        if (input && input.dataset.originalText !== undefined) {
            tdElement.textContent = input.dataset.originalText;
        }
    }

    /**
     * Enter edit mode and convert metadata fields to editable inputs.
     */
    function enterEditMode() {
        if (!metadataTable) return;

        injectMissingFields(metadataTable);

        // Convert each field to editable input
        EDITABLE_FIELDS.forEach(fieldConfig => {
            const row = metadataTable.querySelector('.' + fieldConfig.className);
            if (row) {
                const tdElement = row.querySelector('td');
                if (tdElement) {
                    const currentValue = tdElement.textContent.trim();
                    const input = createFieldInput(fieldConfig, currentValue);
                    tdElement.innerHTML = '';
                    tdElement.appendChild(input);
                }
            }
        });

        // Update button text and add save button
        updateButtonsForEditMode();
    }

    /**
     * Exit edit mode and restore the original field values.
     */
    function exitEditMode() {
        if (!metadataTable) return;

        // Restore all fields to their original values
        EDITABLE_FIELDS.forEach(fieldConfig => {
            const row = metadataTable.querySelector('.' + fieldConfig.className);
            restoreField(row);
        });

        updateButtonsForViewMode();
    }

    /**
     * Update the UI to show edit mode controls (cancel, save, edit summary).
     */
    function updateButtonsForEditMode() {
        const buttonContainer = document.getElementById('exif-editor-controls');
        buttonContainer.innerHTML = '';

        // Create button container
        const buttonsDiv = document.createElement('div');
        buttonsDiv.style.cssText = 'margin-bottom: 10px;';

        const cancelButton = document.createElement('button');
        cancelButton.textContent = 'Cancel';
        cancelButton.style.cssText = 'padding: 8px 16px; background: #72777d; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 14px; margin-right: 10px;';
        cancelButton.addEventListener('click', () => {
            editMode = false;
            exitEditMode();
        });

        const saveButton = document.createElement('button');
        saveButton.textContent = 'Save and Re-upload';
        saveButton.style.cssText = 'padding: 8px 16px; background: #00af89; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 14px;';
        saveButton.addEventListener('click', saveAndReupload);

        buttonsDiv.appendChild(cancelButton);
        buttonsDiv.appendChild(saveButton);

        // Create a container for the edit summary input
        const summaryContainer = document.createElement('div');

        const summaryLabel = document.createElement('label');
        summaryLabel.textContent = 'Edit summary (optional): ';
        summaryLabel.style.cssText = 'display: inline-block; margin-right: 8px; font-weight: bold;';

        const summaryInput = document.createElement('input');
        summaryInput.type = 'text';
        summaryInput.maxLength = MAX_EDIT_SUMMARY_LENGTH;
        summaryInput.id = 'exif-edit-summary';
        summaryInput.placeholder = 'Additional details about your changes';
        summaryInput.style.cssText = 'width: 400px; padding: 6px; font-size: 14px; border: 1px solid #a2a9b1; border-radius: 2px;';

        summaryContainer.appendChild(summaryLabel);
        summaryContainer.appendChild(summaryInput);

        buttonContainer.appendChild(buttonsDiv);
        buttonContainer.appendChild(summaryContainer);
    }

    /**
     * Update the UI to show view mode controls (edit button).
     */
    function updateButtonsForViewMode() {
        const buttonContainer = document.getElementById('exif-editor-controls');
        buttonContainer.innerHTML = '';

        const editButton = document.createElement('button');
        editButton.textContent = 'Edit EXIF';
        editButton.style.cssText = 'padding: 8px 16px; background: #36c; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 14px; margin-right: 10px;';
        editButton.addEventListener('click', toggleEditMode);

        buttonContainer.appendChild(editButton);
    }

    /**
     * Check if a field value should be considered empty.
     * @param {*} value - The value to check.
     * @returns {boolean} True if the value is empty, false otherwise.
     */
    function isEmptyValue(value) {
        return !value || value === '' || value === '(not set)';
    }

    /**
     * Validate GPS coordinate value.
     * @param {number} coord - The coordinate value to validate.
     * @param {string} type - Type of coordinate ('latitude' or 'longitude').
     * @returns {boolean} True if valid, false otherwise.
     */
    function isValidGPSCoordinate(coord, type) {
        if (typeof coord !== 'number' || isNaN(coord) || !isFinite(coord)) {
            return false;
        }
        if (type === 'latitude') {
            return coord >= -90 && coord <= 90;
        } else if (type === 'longitude') {
            return coord >= -MAX_COORDINATE_VALUE && coord <= MAX_COORDINATE_VALUE;
        }
        return false;
    }

    /**
     * Get GPS reference direction for a coordinate.
     * @param {number} value - The coordinate value.
     * @param {string} type - Type of coordinate ('latitude' or 'longitude').
     * @returns {string} The reference direction (N/S for latitude, E/W for longitude).
     */
    function getGPSReference(value, type) {
        if (type === 'latitude') {
            return value >= 0 ? 'N' : 'S';
        } else {
            return value >= 0 ? 'E' : 'W';
        }
    }

    /**
     * Parse GPS coordinates from various formats to decimal degrees.
     * Supports decimal, DMS (degrees minutes seconds), and decimal with direction formats.
     * @param {string} coordStr - The coordinate string to parse.
     * @returns {number|null} The coordinate in decimal degrees, or null if parsing fails.
     */
    function parseGPSCoordinate(coordStr) {
        if (isEmptyValue(coordStr)) return null;

        // Clean up string
        coordStr = coordStr.trim();

        // Try parsing decimal format (e.g., "37.7749" or "37.7749°")
        const decimalMatch = coordStr.match(RE_GPS_DECIMAL);
        if (decimalMatch) {
            return parseFloat(decimalMatch[1]);
        }

        // Try parsing DMS format with various quote styles
        // Handles: 37° 46' 29.64" N, 37° 46′ 29.64″ N, etc.
        const dmsMatch = coordStr.match(RE_GPS_DMS);
        if (dmsMatch) {
            const degrees = parseFloat(dmsMatch[1]);
            const minutes = parseFloat(dmsMatch[2]);
            const seconds = parseFloat(dmsMatch[3]);
            const direction = dmsMatch[4];

            let decimal = degrees + minutes / 60 + seconds / 3600;

            if (direction && (direction.toUpperCase() === 'S' || direction.toUpperCase() === 'W')) {
                decimal = -decimal;
            }

            return decimal;
        }

        // Try parsing format "37.7749 N" or "122.4194 W"
        const decimalDirMatch = coordStr.match(RE_GPS_DECIMAL_DIR);
        if (decimalDirMatch) {
            let decimal = parseFloat(decimalDirMatch[1]);
            const direction = decimalDirMatch[2].toUpperCase();

            if (direction === 'S' || direction === 'W') {
                decimal = -decimal;
            }

            return decimal;
        }

        // Try parsing just a decimal number
        const plainDecimal = parseFloat(coordStr);
        return isNaN(plainDecimal) ? null : plainDecimal;
    }

    /**
     * Parse Wikimedia date format to datetime-local format for HTML input.
     * @param {string} dateStr - Date string in format "HH:MM, DD Month YYYY".
     * @returns {string|null} ISO 8601 format datetime string, or null if parsing fails.
     */
    function parseWikimediaDate(dateStr) {
        const match = dateStr.match(RE_WM_DATE);
        if (match) {
            const [_, hours, minutes, day, month, year] = match;
            const monthNum = MONTHS_MAP[month];
            if (!monthNum) return null;

            const dayPadded = day.padStart(2, '0');

            return `${year}-${monthNum}-${dayPadded}T${hours.padStart(2, '0')}:${minutes}`;
        }

        return null;
    }

    /**
     * Convert datetime-local format to EXIF format.
     * @param {string} dateStr - ISO 8601 format datetime string (e.g., "2025-09-06T07:56").
     * @returns {string} EXIF format datetime string (e.g., "2025:09:06 07:56:00").
     */
    function formatDateForExif(dateStr) {
        const date = new Date(dateStr);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');

        return `${year}:${month}:${day} ${hours}:${minutes}:${seconds}`;
    }

    /**
     * Collect edited data, download the original image, modify EXIF, and re-upload.
     */
    async function saveAndReupload() {
        try {
            return await performSaveAndReupload();
        } catch (error) {
            console.error('[QuickEXIF] Error in saveAndReupload:', error);
            hideLoadingState();
            updateButtonsForEditMode();
            alert('An error occurred while saving: ' + (error.message || 'Unknown error'));
        }
    }

    async function performSaveAndReupload() {
        if (!metadataTable) {
            throw new Error('Metadata table not found');
        }

        const editedData = {};
        const fieldActions = {};
        const allInputs = metadataTable.querySelectorAll('input[data-field-name], textarea[data-field-name]');
        const inputParsingErrors = [];

        allInputs.forEach(input => {
            // Check for browser-detected invalid input (e.g. partial dates in datetime-local)
            if (input.validity && input.validity.badInput) {
                const label = input.closest('tr')?.querySelector('th')?.textContent?.trim() || input.dataset.fieldName;
                inputParsingErrors.push(`Invalid value for field "${label}".`);
                return;
            }

            const fieldName = input.dataset.fieldName;
            // Use dataset.initialValue (set in createFieldInput) for comparison
            const originalValue = input.dataset.initialValue || '';
            const currentValue = input.value ? input.value.trim() : '';

            // Include field if changed
            if (currentValue !== originalValue) {
                editedData[fieldName] = currentValue;

                // Determine action type
                // Actions:
                // 'removed' (clearing a value),
                // 'added' (setting a new value),
                // 'changed' (modifying existing)
                const origEmpty = isEmptyValue(originalValue);
                const currEmpty = isEmptyValue(currentValue) || currentValue === '';

                if (currEmpty) {
                    fieldActions[fieldName] = 'removed';
                } else if (origEmpty) {
                    fieldActions[fieldName] = 'added';
                } else {
                    fieldActions[fieldName] = 'changed';
                }
            }
        });

        if (inputParsingErrors.length > 0) {
            alert('Validation failed:\n' + inputParsingErrors.join('\n'));
            return;
        }

        if (Object.keys(editedData).length === 0) {
            alert('No changes detected. Please modify at least one field.');
            return;
        }

        // Validate edited data
        const validation = validateEditedData(editedData);
        if (!validation.isValid) {
            alert('Validation failed:\n' + validation.errors.join('\n'));
            return;
        }

        if (mw.user.isAnon()) {
            alert('You must be logged in to upload files. Please log in and try again.');
            return;
        }

        const customSummaryInput = document.getElementById('exif-edit-summary');
        const customSummary = customSummaryInput ? customSummaryInput.value.trim() : '';

        showLoadingState('Downloading image...');

        try {
            const imageUrl = getOriginalImageUrl();
            if (!imageUrl) {
                throw new Error('Could not find original image URL');
            }

            const imageBlob = await downloadImage(imageUrl);

            showLoadingState('Modifying EXIF data...');
            const modifiedBlob = await modifyExifData(imageBlob, editedData, fieldActions);

            showLoadingState('Uploading to Commons...');
            await uploadToCommons(modifiedBlob, customSummary, editedData, fieldActions);

            showSuccessMessage();
        } catch (error) {
            throw error;
        }
    }

    /**
     * Get the URL of the original full-resolution image.
     * @returns {string|null} The image URL, or null if not found.
     */
    function getOriginalImageUrl() {
        // Primary method: look for full resolution link
        const fullResLink = document.querySelector('.fullMedia a');
        if (fullResLink && fullResLink.href) {
            return fullResLink.href;
        }

        // Fallback: construct URL from filename
        if (currentFileName) {
            const imageUrl = mw.config.get('wgServer') + mw.config.get('wgScriptPath') + '/index.php?title=Special:Redirect/file/' + encodeURIComponent(currentFileName);
            return imageUrl;
        }

        return null;
    }

    /**
     * Download an image from a URL.
     * @param {string} url - The URL of the image to download.
     * @returns {Promise<Blob>} Promise that resolves to the image blob.
     */
    async function downloadImage(url) {
        if (!url) {
            throw new Error('Invalid image URL');
        }

        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Failed to download image: ${response.status} ${response.statusText}`);
            }
            const blob = await response.blob();
            if (!blob || blob.size === 0) {
                throw new Error('Downloaded image is empty');
            }
            return blob;
        } catch (error) {
            throw new Error('Network error while downloading image: ' + error.message);
        }
    }

    /**
     * Modify EXIF data in the image.
     * @param {Blob} blob - The image blob to modify.
     * @param {Object} editedData - Object containing the edited field values.
     * @returns {Promise<Blob>} Promise that resolves to a new blob with modified EXIF data.
     */
    /**
     * Validate edited data before applying to EXIF.
     * @param {Object} editedData - The edited data to validate.
     * @returns {Object} Validation result with isValid and errors properties.
     */
    function validateEditedData(editedData) {
        const errors = [];

        // Validate GPS coordinates
        const gpsFields = [
            { key: 'gpslatitude', type: 'latitude', range: '90' },
            { key: 'gpslongitude', type: 'longitude', range: String(MAX_COORDINATE_VALUE) }
        ];

        gpsFields.forEach(field => {
            const value = editedData[field.key];
            if (value !== undefined && value !== null && value !== '') {
                const coord = parseFloat(value);
                if (!isValidGPSCoordinate(coord, field.type)) {
                    errors.push(`Invalid ${field.type} value. Must be between -${field.range} and ${field.range}.`);
                }
            }
        });

        // Validate datetime
        if (editedData.datetimeoriginal !== undefined && editedData.datetimeoriginal !== '') {
            // Validate datetime-local format: YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS
            if (!RE_ISO_DATE.test(editedData.datetimeoriginal)) {
                errors.push('Invalid date/time format. Please use the date and time picker to select a complete date and time.');
            } else {
                // Check if the input date is valid
                const testDate = new Date(editedData.datetimeoriginal);
                if (isNaN(testDate.getTime())) {
                    errors.push('Invalid date/time value.');
                } else {
                    const exifDateTime = formatDateForExif(editedData.datetimeoriginal);
                    if (!EXIF_DATE_FORMAT.test(exifDateTime)) {
                        errors.push('Invalid date/time format. Expected format: YYYY:MM:DD HH:MM:SS');
                    }
                }
            }
        }

        return {
            isValid: errors.length === 0,
            errors: errors
        };
    }

    function modifyExifData(blob, editedData, fieldActions) {
        if (!blob || blob.size === 0) {
            throw new Error('Invalid image blob: blob is empty');
        }

        if (blob.type && !blob.type.startsWith('image/')) {
            throw new Error('Invalid blob type: expected image, got ' + blob.type);
        }

        fieldActions = fieldActions || {};

        return new Promise((resolve, reject) => {
            const reader = new FileReader();

            reader.onload = function (e) {
                try {
                    const dataUrl = e.target.result;

                    if (!dataUrl || typeof dataUrl !== 'string') {
                        throw new Error('Failed to read image data');
                    }

                    let exifObj;
                    try {
                        exifObj = piexif.load(dataUrl);
                    } catch (err) {
                        exifObj = {
                            "0th": {},
                            "Exif": {},
                            "GPS": {},
                            "Interop": {},
                            "1st": {},
                            "thumbnail": null
                        };
                    }

                    // Ensure required dicts exist
                    if (!exifObj['Exif']) {
                        exifObj['Exif'] = {};
                    }
                    if (!exifObj['0th']) {
                        exifObj['0th'] = {};
                    }
                    if (!exifObj['GPS']) {
                        exifObj['GPS'] = {};
                    }

                    // Modify or clear DateTimeOriginal
                    if (editedData.datetimeoriginal !== undefined) {
                        if (editedData.datetimeoriginal) {
                            const exifDateTime = formatDateForExif(editedData.datetimeoriginal);
                            exifObj['Exif'][piexif.ExifIFD.DateTimeOriginal] = exifDateTime;
                            exifObj['Exif'][piexif.ExifIFD.DateTimeDigitized] = exifDateTime;
                        } else {
                            delete exifObj['Exif'][piexif.ExifIFD.DateTimeOriginal];
                            delete exifObj['Exif'][piexif.ExifIFD.DateTimeDigitized];
                        }
                    }

                    // Modify or clear Image Description
                    if (editedData.imagedescription !== undefined) {
                        if (editedData.imagedescription) {
                            exifObj['0th'][piexif.ImageIFD.ImageDescription] = editedData.imagedescription;
                        } else {
                            delete exifObj['0th'][piexif.ImageIFD.ImageDescription];
                        }
                    }

                    // Modify or clear Artist
                    if (editedData.artist !== undefined) {
                        if (editedData.artist) {
                            exifObj['0th'][piexif.ImageIFD.Artist] = editedData.artist;
                        } else {
                            delete exifObj['0th'][piexif.ImageIFD.Artist];
                        }
                    }

                    // Modify or clear Copyright
                    if (editedData.copyright !== undefined) {
                        if (editedData.copyright) {
                            exifObj['0th'][piexif.ImageIFD.Copyright] = editedData.copyright;
                        } else {
                            delete exifObj['0th'][piexif.ImageIFD.Copyright];
                        }
                    }

                    // Modify or clear User Comment
                    if (editedData.usercomment !== undefined) {
                        if (editedData.usercomment) {
                            // UserComment requires 8-byte character code prefix
                            exifObj['Exif'][piexif.ExifIFD.UserComment] = USERCOMMENT_CHARSET_PREFIX + editedData.usercomment;
                        } else {
                            delete exifObj['Exif'][piexif.ExifIFD.UserComment];
                        }
                    }

                    // Helper to set or clear GPS coordinate
                    const setGPSCoordinate = (value, coordField, refField, type) => {
                        if (value !== '') {
                            const coord = parseFloat(value);
                            if (!isNaN(coord)) {
                                const ref = getGPSReference(coord, type);
                                const dms = piexif.GPSHelper.degToDmsRational(Math.abs(coord));
                                exifObj['GPS'][coordField] = dms;
                                exifObj['GPS'][refField] = ref;
                            }
                        } else {
                            delete exifObj['GPS'][coordField];
                            delete exifObj['GPS'][refField];
                        }
                    };

                    // Modify or clear GPS Latitude
                    if (editedData.gpslatitude !== undefined) {
                        setGPSCoordinate(
                            editedData.gpslatitude,
                            piexif.GPSIFD.GPSLatitude,
                            piexif.GPSIFD.GPSLatitudeRef,
                            'latitude'
                        );
                    }

                    // Modify or clear GPS Longitude
                    if (editedData.gpslongitude !== undefined) {
                        setGPSCoordinate(
                            editedData.gpslongitude,
                            piexif.GPSIFD.GPSLongitude,
                            piexif.GPSIFD.GPSLongitudeRef,
                            'longitude'
                        );
                    }

                    // If GPS data was set, ensure basic GPS fields are present
                    if (Object.keys(exifObj['GPS']).length > 0) {
                        // Set GPS version to 2.2.0.0
                        if (!exifObj['GPS'][piexif.GPSIFD.GPSVersionID]) {
                            exifObj['GPS'][piexif.GPSIFD.GPSVersionID] = GPS_VERSION;
                        }

                        // Set map datum to WGS-84
                        if (!exifObj['GPS'][piexif.GPSIFD.GPSMapDatum]) {
                            exifObj['GPS'][piexif.GPSIFD.GPSMapDatum] = GPS_MAP_DATUM;
                        }

                        // Set GPS date stamp from DateTimeOriginal if available
                        if (!exifObj['GPS'][piexif.GPSIFD.GPSDateStamp] && editedData.datetimeoriginal) {
                            const datePart = formatDateForExif(editedData.datetimeoriginal).split(' ')[0];
                            exifObj['GPS'][piexif.GPSIFD.GPSDateStamp] = datePart;
                        }

                        // Set GPS tag pointer
                        if (!exifObj['0th'][piexif.ImageIFD.GPSTag]) {
                            exifObj['0th'][piexif.ImageIFD.GPSTag] = 0;
                        }
                    }

                    // Serialize EXIF data
                    const exifBytes = piexif.dump(exifObj);

                    // Log summary of changes
                    const modifiedFields = [];
                    Object.keys(editedData).forEach(key => {
                        const displayName = FIELD_NAME_MAP[key] || key;
                        const action = fieldActions[key] || 'changed';
                        modifiedFields.push(`${displayName} (${action})`);
                    });

                    console.log('[QuickEXIF] Modified EXIF fields:', modifiedFields.join(', '));

                    // Insert EXIF into image
                    const newDataUrl = piexif.insert(exifBytes, dataUrl);

                    // Convert data URL to blob
                    fetch(newDataUrl)
                        .then(res => res.blob())
                        .then(newBlob => resolve(newBlob))
                        .catch(reject);

                } catch (error) {
                    reject(new Error('Failed to modify EXIF data: ' + error.message));
                }
            };

            reader.onerror = function () {
                reject(new Error('Failed to read image file'));
            };

            reader.readAsDataURL(blob);
        });
    }

    /**
     * Upload modified image to Wikimedia Commons.
     * @param {Blob} blob - The image blob to upload.
     * @param {string} customSummary - Optional custom edit summary to append.
     * @param {Object} editedData - The edited field data.
     * @param {Object} fieldActions - Actions taken on each field (added/changed/removed).
     * @returns {Promise<Object>} Promise that resolves to the upload result.
     */
    async function uploadToCommons(blob, customSummary, editedData, fieldActions) {
        if (!blob || blob.size === 0) {
            throw new Error('Invalid image blob for upload');
        }

        if (!currentFileName) {
            throw new Error('File name is not set');
        }

        if (!api) {
            throw new Error('MediaWiki API not initialized');
        }

        try {
            const file = new File([blob], currentFileName, { type: blob.type || 'image/jpeg' });

            // Build field changes summary
            const fieldsByAction = {
                added: new Set(),
                changed: new Set(),
                removed: new Set()
            };

            Object.keys(editedData || {}).forEach(key => {
                const displayName = FIELD_NAME_MAP[key] || key;
                const action = (fieldActions && fieldActions[key]) || 'changed';
                if (fieldsByAction[action]) {
                    fieldsByAction[action].add(displayName);
                }
            });

            const summaryParts = [];
            if (fieldsByAction.added.size > 0) {
                summaryParts.push('Added ' + Array.from(fieldsByAction.added).join(', '));
            }
            if (fieldsByAction.changed.size > 0) {
                summaryParts.push('Updated ' + Array.from(fieldsByAction.changed).join(', '));
            }
            if (fieldsByAction.removed.size > 0) {
                summaryParts.push('Removed ' + Array.from(fieldsByAction.removed).join(', '));
            }

            let editSummary = 'Change EXIF via QuickEXIF';
            if (summaryParts.length > 0) {
                editSummary += ': ' + summaryParts.join('; ');
            }

            if (customSummary && customSummary.trim()) {
                const sanitized = customSummary.trim().substring(0, MAX_EDIT_SUMMARY_LENGTH);
                editSummary += ' – ' + sanitized;
            }

            // Truncate if too long
            if (editSummary.length > MAX_EDIT_SUMMARY_LENGTH) {
                editSummary = editSummary.substring(0, MAX_EDIT_SUMMARY_LENGTH - 3) + '...';
            }

            // Upload using MediaWiki API
            const result = await api.upload(file, {
                filename: currentFileName,
                comment: editSummary,
                tags: 'QuickEXIF',
                ignorewarnings: 1 // Allow overwriting existing file
            });

            if (result && result.upload && result.upload.result === 'Success') {
                return result;
            }

            // Construct detailed error message
            let errorMsg = 'Unknown error';
            if (result && result.upload && result.upload.result) {
                errorMsg = result.upload.result;
                if (result.upload.warnings) {
                    errorMsg += ' (Warnings: ' + JSON.stringify(result.upload.warnings) + ')';
                }
            } else if (result && result.error) {
                errorMsg = result.error.info || result.error.code || 'API error';
            }
            throw new Error('Upload failed: ' + errorMsg);
        } catch (error) {
            if (typeof error === 'string' && error === currentFileName) {
                return { upload: { result: 'Success' } };
            }

            throw new Error('Failed to upload to Commons: ' + (error && error.message ? error.message : error));
        }
    }

    /**
     * Display a loading message to the user.
     * @param {string} message - The message to display.
     */
    function showLoadingState(message) {
        const buttonContainer = document.getElementById('exif-editor-controls');
        if (!buttonContainer) {
            console.warn('[QuickEXIF] Button container not found for loading state');
            return;
        }

        let loadingDiv = document.getElementById('exif-loading');

        // Remove all children except loadingDiv
        Array.from(buttonContainer.children).forEach(child => {
            if (child.id !== 'exif-loading') {
                buttonContainer.removeChild(child);
            }
        });

        if (!loadingDiv) {
            loadingDiv = document.createElement('div');
            loadingDiv.id = 'exif-loading';
            loadingDiv.style.cssText = 'margin-top: 10px; padding: 10px; background: #fef6e7; border: 1px solid #f4d03f; border-radius: 3px; font-style: italic; min-width: 200px; color: #856404;';
            buttonContainer.appendChild(loadingDiv);
        }
        loadingDiv.textContent = message || 'Processing...';
    }

    /**
     * Hide the loading message.
     */
    function hideLoadingState() {
        const loadingDiv = document.getElementById('exif-loading');
        if (loadingDiv) {
            loadingDiv.remove();
        }
    }

    /**
     * Display a success message and reload the page after a delay.
     */
    function showSuccessMessage() {
        hideLoadingState();
        editMode = false;
        const buttonContainer = document.getElementById('exif-editor-controls');

        if (!buttonContainer) {
            console.warn('[QuickEXIF] Button container not found, reloading immediately');
            location.reload();
            return;
        }

        // Remove cancel/save buttons
        const buttons = buttonContainer.querySelectorAll('button');
        buttons.forEach(btn => btn.remove());

        // Show success message
        const messageDiv = document.createElement('div');
        messageDiv.style.cssText = 'margin-top: 10px; padding: 10px; background: #d4edda; border: 1px solid #c3e6cb; border-radius: 3px; color: #155724;';
        const strongText = document.createElement('strong');
        strongText.textContent = '✓ Successfully uploaded!';
        messageDiv.appendChild(strongText);
        messageDiv.appendChild(document.createElement('br'));
        messageDiv.appendChild(document.createTextNode('The file has been updated with the new EXIF data. The page will reload in a moment...'));
        
        buttonContainer.appendChild(messageDiv);

        // Reload after a delay to show the updated file
        setTimeout(() => {
            location.reload();
        }, SUCCESS_RELOAD_DELAY);
    }

    // Initialize when the page is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
